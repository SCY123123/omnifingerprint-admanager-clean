// @ts-nocheck
/**
 * 服务端批量任务队列（持久化）
 *
 * 背景：以前所有批量操作都在前端循环里跑（for/await），带来三个问题：
 *   1. 前端刷新 / 切页 / 断网 → 整个批量任务直接中断，已做的白做；
 *   2. 界面只有一个转圈，看不到进行到第几个；
 *   3. 想停下来只能等当前那个请求自己返回。
 *
 * 现在改为：前端只负责「提交任务」，真正的执行放在本机后端，任务与每个子项的
 * 进度/结果都落盘到 SQLite（server/data/omnifingerprint.db 的 jobs 表）。
 * 因此：
 *   - 前端刷新 / 关页面 / 断网，任务照跑；
 *   - 后端崩溃或重启，未完成的 job 会在启动时恢复成 queued 继续跑；
 *   - 前端随时可查进度、单独取消某个 job、或一键取消全部。
 *
 * 每个 job = 一批同类型操作（例如「获取信息」里勾选的 N 个配置），
 * job 内部的 items 逐个执行并各自记录状态。
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;
// 单个 item 的执行上限：慢操作本身 30~70s，再算上等服务端浏览器并发空位（最长 150s）
// ⚠️ 必须留够「排队等空位 + 启动 + 抓取」的余量，否则会把内部等待误报成任务超时。
//    取值需大于回环 HTTP 超时（LOCAL_FETCH_TIMEOUT_MS，默认 280s）——这样先由内层报出具体原因，
//    而不是被队列一刀切掉。
const ITEM_TIMEOUT_MS = parseInt(process.env.JOB_ITEM_TIMEOUT_MS || '600000', 10);

// 🔎 浏览器失活探测间隔：配置的浏览器被手动关掉/崩溃后，本机那条接口会一直挂着不返回，
//    只靠 socket 空闲超时要干等 280s。改成每 5s 查一次活着的浏览器列表，几秒内就能判失败。
const PROBE_INTERVAL_MS = parseInt(process.env.JOB_BROWSER_PROBE_MS || '5000', 10) || 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

// 常规查询列：故意排除 shared —— 它可能是几十 MB（广告素材 base64），
// 列表/恢复/详情都不需要它，只有真正执行任务时才单独取。
const JOB_COLS = 'id, type, title, status, total, done, ok, fail, concurrency, items, error, created_at, started_at, finished_at';

/** 把服务端返回的 JSON 归一成 {success, message, raw} */
const norm = (json, okMessage) => {
    if (json && json.success) return { success: true, message: okMessage || '成功', raw: json };
    const msg = (json && (json.message || json.error || json.msg)) || '失败（接口未返回 success）';
    return { success: false, message: String(msg).slice(0, 300), raw: json };
};

/**
 * 各种慢操作的执行方式：统一走本机自己的 HTTP 接口，
 * 避免把已有的一大堆 handler 逻辑再复制一遍到队列里。
 */
function buildOps(port, apiSecret, onAssets, log) {
    const _log = typeof log === 'function' ? log : () => { };
    const call = async (p, body, signal) => {
        const resp = await fetch(`http://127.0.0.1:${port}${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret || '' },
            body: JSON.stringify(body || {}),
            signal,
        });
        let json = null;
        try { json = await resp.json(); } catch { json = { success: false, message: `HTTP ${resp.status}` }; }
        return json;
    };

    // 🪶 「临时借用浏览器」：批量取数这类任务用完就该把浏览器还回去。
    //    ⚠️ 以前这两步用的是不带 borrow 的 /api/launch-browser，浏览器会一直开着 ——
    //       全局闸门只有 N 个名额，跑满 N 个之后后面的配置全都在「等空位」，150s 后超时失败，
    //       整批看起来就是「卡住不动」。带上 borrow 后：只有**本次真的由我们启动**的浏览器才会计入
    //       借用（已在运行的实例是复用，不会误关用户自己开着的窗口），跑完立刻归还、把名额让给下一项。
    // 🕒 硬上限：等名额（LAUNCH_WAIT_MS，现 30s）+ 启动本身（LaunchQueue 任务超时 120s）+ 余量。
    //    以前这里完全没有超时：只要 /api/launch-browser 因为任何原因不回响应（例如那个
    //    「客户端已断开」的静默 return），这一项就会一直挂到单项总超时（默认 10 分钟），
    //    整批看起来就是「超出并发后卡住，别人跑完关掉浏览器也不继续」。
    const LAUNCH_CALL_TIMEOUT_MS = parseInt(process.env.JOB_LAUNCH_TIMEOUT_MS || '160000', 10);
    const borrowLaunch = async (pid, signal, opts) => {
        const ctrl = new AbortController();
        const onAbort = () => { try { ctrl.abort(); } catch { } };
        if (signal) {
            if (signal.aborted) { try { ctrl.abort(); } catch { } }
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        // ⏳ awaitLogin 时，启动端会额外「等登录校验/自动登录跑完」才返回（最多 100s），
        //    所以这次调用的超时也要留出余量，否则会在启动端还在等待时被我们 abort 掉。
        const callTimeout = (opts && opts.awaitLogin) ? Math.max(LAUNCH_CALL_TIMEOUT_MS, 220000) : LAUNCH_CALL_TIMEOUT_MS;
        const timer = setTimeout(() => { try { ctrl.abort(); } catch { } }, callTimeout);
        try {
            // opts.maxMs：本次借用的绝对上限覆盖（长耗时 puppeteer 重活用，如绑卡/BM认证）
            // opts.awaitLogin：要求启动端等登录流程结束再返回（「获取信息」用它避免抢跑）
            const l = await call('/api/launch-browser', { profileId: pid, borrow: true, ...(opts && opts.maxMs ? { borrowMaxMs: opts.maxMs } : {}), ...(opts && opts.awaitLogin ? { awaitLogin: true } : {}) }, ctrl.signal).catch(() => null);
            const d = (l && l.data) || {};
            // 🔐 回传登录结论（只有 awaitLogin 时启动端才会给，其余情况为 null）：
            //    调用方据此决定「还要不要继续后续动作」—— 没登录成功就别白跑取数、白占槽位。
            if (opts && opts.meta) opts.meta.loginOk = (l && typeof l.loginOk === 'boolean') ? l.loginOk : null;
            const reused = !!d.reused;
            // 🐛 复用的浏览器分两种，必须区别对待：
            //    · owned=true —— 复用的这个本来就是「借用型」的（上一轮队列借来还没还），它归队列管：
            //      用完照常归还（关闭），名额当场释放。以前一律不归还 → 它一直占着 activeBrowsers，
            //      队列名额被白占，尾巴上那几项要多等一整轮（实测 6 项/并发 5，第 6 项等了 66s）。
            //    · owned=false —— 是你自己手动开着的窗口：不标记、不关闭，只借用（闸门也不再算它）。
            // 🐛 另外：防重入分支（duplicate）现在带 reused:true，不会再被误判成「本次启动」
            //    从而去 /api/stop-browser 关掉另一个并发项正在用的浏览器。
            const owned = !!d.owned;
            const startedByUs = !!(l && l.success) && (!reused || owned);
            // 🎯 失活探测的放行标记：本任务项的浏览器已真正就绪（无论谁启动的）。
            //    没有这个标记（还在排队等闸门/等启动）时，探测不许判「browser-gone」——
            //    否则排队期间前一个任务的浏览器正常关闭会被误判成本任务失活。
            if (l && l.success && signal) { try { signal.__browserReady = true; } catch { } }
            _log('INFO', `🧵 [JobQueue] 借用 ${pid}：${reused ? (owned ? '复用我方借用实例' : '复用常驻实例') : '新启动'}（${startedByUs ? '用完归还' : '用完不归还'}）`);
            return startedByUs;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    };
    const releaseBorrowed = async (pid, startedByUs) => {
        if (!startedByUs) return;
        // 🕒 不带 signal：即使任务被取消也要把浏览器还掉；顺带用 AbortController 限个时，避免卡住这一格并发
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
            const r = await call('/api/stop-browser', { profileId: pid }, ctrl.signal).catch(() => null);
            _log('INFO', `🧵 [JobQueue] 归还 ${pid}：${r && r.success ? '已关闭，名额已释放' : `关闭失败(${(r && (r.message || r.error)) || '无响应'})`}`);
        } finally {
            clearTimeout(timer);
        }
    };

    // 🔁 create_bm_bundle 的主体（从 op 里拆出来，方便外层统一做浏览器借用/归还）
    const _runCreateBmBundle = async (item, { signal }, _startedByUs, _pid) => {
        const p = item.payload;
        const bmJson = await call('/api/facebook/business/create', p, signal);
        if (!bmJson || !bmJson.success) return norm(bmJson, '');
        const businessId = bmJson.businessId || (bmJson.data && bmJson.data.id) || '';
        const notes = [];
        if (p.createAdAccount && businessId) {
            // 🐛 原本硬编码 timezoneId: 0，Meta 的 POST /{bm}/adaccount 只认有效时区枚举（从 1 起），
            //    于是「创建BM时顺带建广告号」这条路必然报 (#100) Must include a valid timezone ID。
            // 🆕 同时透传命名方式（手填/随机/时间戳）、数量与账单信息；
            //    不透传的话这条路径会退化成「用 BM 名建 1 个广告号、且不写账单」。
            const adJson = await call('/api/facebook/businesses/create-adaccount', {
                profileId: p.profileId, businessId,
                name: p.name,
                adNameMode: p.adNameMode || 'manual',
                adNameManual: p.adNameManual || p.name,
                count: p.adAccountCount || 1,   // ⚠️ create-adaccount 路由收的字段名是 count
                adBilling: p.adBilling,
                timezoneId: p.timezoneId || 1,
                currency: p.currency || 'USD',
                assignAdmin: true,
            }, signal).catch(() => null);
            const adCount = Number(p.adAccountCount) || 1;
            notes.push(adJson && adJson.success
                ? (adCount > 1 ? `广告号 ${adCount} 个已建` : '广告号已建')
                : '广告号失败');
        }
        if (p.createPage) {
            const pageName = p.defaultPageName || `${p.name}-Page-1`;
            const pgJson = await call('/api/facebook/pages/create-and-grant', {
                profileId: p.profileId, name: pageName, businessId: businessId || undefined, proxyOverride: p.proxyOverride,
            }, signal).catch(() => null);
            notes.push(pgJson && pgJson.success ? '主页已建' : '主页失败');
        }
        // 📧 可选：BM 建好后自动生成 N 个邀请链接（每个链接一个独立临时邮箱）
        //    串行慢操作（每个要轮询收信最长 pollSeconds 秒），放在 BM 创建之后、同一队列项内完成，
        //    这样「创建BM」一步就能拿到可复制的邀请链接。
        if (Number(p.inviteCount) > 0 && businessId) {
            const inv = await call('/api/facebook/business/generate-invite-links', {
                profileId: p.profileId, businessId,
                count: Number(p.inviteCount),
                role: p.inviteRole || 'employee',
                pollSeconds: p.invitePollSeconds || 45,
                // 🛒 自动上架商城联动（创建BM弹窗勾选时透传）
                shopPublish: p.shopPublish,
                shopPrice: p.shopPrice,
                shopCurrency: p.shopCurrency,
            }, signal).catch(() => null);
            // 🛒 notes 里带上商城上架结果（成功/失败都要让用户看到）
            let invNote;
            if (inv && inv.success) {
                invNote = `邀请链接 ${inv.generated}/${inv.requested} 个已生成`;
                if (inv.shop && inv.shop.success) invNote += `，已自动上架商城(商品#${inv.shop.id}，+${inv.shop.added}条)`;
                else if (inv.shop && inv.shop.success === false) invNote += `，自动上架失败: ${inv.shop.message || ''}`;
            } else {
                invNote = '邀请链接生成失败';
            }
            notes.push(invNote);
        }
        return {
            success: true,
            message: `BM「${p.name}」已创建${businessId ? ` (${businessId})` : ''}${notes.length ? ' · ' + notes.join(' · ') : ''}`,
            raw: bmJson,
        };
    };

    return {
        launch_browser: {
            label: '启动浏览器',
            // payload 可带 startUrls / strictVerifyOnly / strictStartUrls 等启动参数（不传则由服务端按配置默认处理）
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                // 🕒 awaitLogin：等「页面内容校验 / 自动登录」跑完再返回。以前启动完立刻返回 → 队列项当场报
                //    「已启动（成功）」，而 AutoLogin 还在后台跑；等它 30 秒后报「未登录成功」时，这一项早结束了，
                //    既没人提示、也没人管，未登录的窗口就那么留着（5875 实测）。
                const json = await call('/api/launch-browser', { ...(item.payload || {}), profileId: pid, awaitLogin: true }, signal);
                // 🚫 登录没成功 → 让这一项失败（明确提示需人工登录）。
                //    · 批量操作（默认）：顺手关掉浏览器，不留未登录的窗口。
                //    · 单个启动（payload.keepBrowserOnLoginFail=true）：**保留窗口**，方便用户直接在这个
                //      浏览器里手动登录（登录成功后会由 Cookie 同步监听自动回传云端），只记失败不关窗。
                //    ⚠️ 关闭调用不带 signal：任务被取消时也要能关掉；失败静默（关不掉还有 60s 空闲回收兜底）。
                if (json && json.success && json.loginOk === false) {
                    const keepBrowser = !!(item.payload && item.payload.keepBrowserOnLoginFail);
                    if (!keepBrowser) {
                        try {
                            await call('/api/stop-browser', { profileId: pid, reason: '启动后自动登录未成功，已放弃启动', by: 'JobQueue/launch_browser' }).catch(() => null);
                        } catch {}
                    }
                    throw new Error(`配置 ${pid} 启动后未登录成功（需人工登录）${keepBrowser ? '，浏览器已保留，请在该窗口中手动登录' : '，已关闭浏览器'}`);
                }
                return norm(json, `配置 ${pid} 已启动`);
            },
        },
        stop_browser: {
            label: '关闭浏览器',
            run: async (item, { signal }) => norm(await call('/api/stop-browser', { profileId: item.payload.profileId }, signal), `配置 ${item.payload.profileId} 已关闭`),
        },
        get_info: {
            label: '获取信息',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                // 🕒 awaitLogin：先让启动端把「页面内容校验 / 自动登录」跑完再返回，然后才去取数 ——
                //    否则取数会抢在 AutoLogin 还没结束时就开跑，抓回来一片空。
                const launchMeta = {};
                const startedByUs = await borrowLaunch(pid, signal, { awaitLogin: true, meta: launchMeta });
                try {
                    // 🚫 自动登录没成功 → 直接放弃这一项：取数必然拿不到数据，只会白占浏览器和并发槽位。
                    //    throw 交给队列记为失败；finally 里的 releaseBorrowed 会把本次借来的浏览器关掉。
                    if (launchMeta.loginOk === false) {
                        throw new Error(`配置 ${pid} 未登录成功（需人工登录），已放弃取数`);
                    }
                    // ⏱️ 这里以前有一句固定 `await sleep(4000)`：启动端点在响应前已经完成了导航 +
                    //    登录态校验，这 4 秒纯属白等 —— 批量 6 项就白等 24 秒，还全部记在槽位占用时间里。
                    // 🪶 keepBrowser:true —— 浏览器由本项在 finally 里统一归还关闭，
                    //    避免取数接口提前关掉它（队列的失活探测会误判成「浏览器已关闭，中止当前任务项」）。
                    // 🔁 单次 success:false / 广告号数为 0 / 网络异常 → 5 秒后重试 1 次：
                    //    「真没广告号」和「抓取丢包/风控抖动」无法区分，宁可多跑一次也不把丢包当结果；
                    //    仅重试一次，任务取消（signal 中止）不重试。token 失效在 fetch 层已有重提重试，
                    //    这里是兜底：连 fetch 层都失败时，队列层再给一次机会。
                    const once = async () => {
                        const json = await call('/api/facebook/fetch-adaccounts-graph', { ...(item.payload || {}), profileId: pid, keepBrowser: true, accessToken: item.payload.accessToken || 'BROWSER' }, signal);
                        const ok = !!(json && json.success);
                        const count = ok && Array.isArray(json.data) ? json.data.length : 0;
                        return { json, ok, count };
                    };
                    let result = null;
                    let lastErr = null;
                    try {
                        result = await once();
                    } catch (e) {
                        if (signal && signal.aborted) throw e; // 取消/超时：不重试，直接交给队列判定
                        lastErr = e;
                    }
                    let retried = false;
                    // 🩺 Token 失效/人机验证是确定性失败（需人工过 checkpoint），重试纯白跑（fetch 层内部已试过重取 token）
                    const deadTokenMsg = result && result.json && typeof result.json.message === 'string' && /Token 失效|人机验证/.test(result.json.message);
                    if (!deadTokenMsg && (!result || !result.ok || result.count === 0)) {
                        await sleep(5000);
                        if (!(signal && signal.aborted)) {
                            try {
                                result = await once();
                                lastErr = null;
                                retried = true;
                            } catch (e2) {
                                if (signal && signal.aborted) throw e2;
                                lastErr = e2;
                                result = null;
                            }
                        }
                    }
                    if (lastErr) throw lastErr;
                    const json = result.json;
                    if (json && json.success) {
                        // 原始抓取结果暂存起来，供前端跑完后写回本地缓存（资产页的 cache:* 依赖这份数据）
                        // 🩺 「账号质量」不用在这里单独查了：fetch-adaccounts-graph 会在**关闭浏览器之前**
                        //    自己完成（请求体里的 withAccountQuality 由下面的 ...item.payload 透传过去）。
                        //    以前放在这里查，那时候浏览器已经被取数接口关掉了 → 每次都只能拿到 no_browser。
                        try { onAssets(pid, json); } catch { }
                        const adAccounts = Array.isArray(json.data) ? json.data.length : 0;
                        return { success: true, message: `配置 ${pid} 已刷新：广告账户 ${adAccounts} 个${retried ? '（5s 重试后）' : ''}`, raw: json };
                    }
                    return norm(json, '');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        fetch_posts: {
            label: '拉取贴文/对话',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    // ⏱️ 同上：固定的 4 秒等待已移除（启动响应本身就代表已就绪）；keepBrowser 同理
                    const json = await call('/api/facebook/fetch-adaccounts-graph', { ...(item.payload || {}), profileId: pid, keepBrowser: true, accessToken: item.payload.accessToken || 'BROWSER' }, signal);
                    if (json && json.success) {
                        try { onAssets(pid, json); } catch { }
                        const p = typeof json.postsCount === 'number' ? json.postsCount : 0;
                        const c = typeof json.conversationsCount === 'number' ? json.conversationsCount : 0;
                        return { success: true, message: `配置 ${pid} 已拉取：贴文 ${p} 条、对话 ${c} 条`, raw: json };
                    }
                    return norm(json, '');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        // 📊 数据追踪：广告层级 insights（一次抓一个配置下的若干广告号；结果由本地后端直接同步云端）
        fetch_insights: {
            label: '同步广告数据',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    const json = await call('/api/facebook/adaccounts/insights', { ...(item.payload || {}), profileId: pid }, signal);
                    if (json && json.success) {
                        const errs = Array.isArray(json.errors) && json.errors.length ? `（${json.errors.length} 个失败）` : '';
                        return { success: true, message: `配置 ${pid} 数据已同步：${json.accounts || 0} 个广告号 / ${json.total || 0} 条广告${errs}`, raw: json };
                    }
                    return norm(json, '');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        // 💳 账单查询：广告号花费/余额/支付方式（结果同步云端 ad_accounts）
        fetch_billing: {
            label: '查询账单信息',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    const json = await call('/api/facebook/adaccounts/billing-info', { ...(item.payload || {}), profileId: pid }, signal);
                    if (json && json.success) {
                        const errs = Array.isArray(json.errors) && json.errors.length ? `（${json.errors.length} 个失败）` : '';
                        return { success: true, message: `配置 ${pid} 账单已更新：${json.total || 0} 个广告号${errs}`, raw: json };
                    }
                    return norm(json, '');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        create_bm: {
            label: '创建BM',
            // 🔁 接入借用模型 + 连续任务复用浏览器：borrowLaunch 启动的浏览器接口端会复用且不自关；
            //    同 profile 还有后续任务项（如再建 4 个 BM、建广告号）时不归还，下一项直接复用，
            //    省掉每次 10~30s 冷启动。最后一项正常归还；保留期间链断（取消/清空）由
            //    BORROWED_IDLE_MS 空闲回收兜底关闭，不会永久占用名额。
            run: async (item, { signal, hasNextForProfile }) => {
                const pid = item.payload.profileId;
                // ⚠️ 不传 maxMs（=不设硬上限）：6 分钟硬上限会杀在邀请链接轮询收信的半路，
                //    且 process.kill 强杀导致新会话 Cookie 没落盘 → 同号下一个任务重启动后
                //    本机/云端都是旧 Cookie →「会话丢失」。生命周期交给四重兜底：
                //    单项总超时(10min) / 取消 finally 归还 / 60s 空闲回收 / inFlight 泄漏保险丝。
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    return norm(await call('/api/facebook/business/create', item.payload, signal), `BM「${item.payload.name}」已创建`);
                } finally {
                    if (hasNextForProfile && await hasNextForProfile(pid)) {
                        _log('INFO', `🔁 [JobQueue] ${pid} 还有同号后续任务，浏览器保留给下一项复用`);
                    } else {
                        await releaseBorrowed(pid, startedByUs);
                    }
                }
            },
        },
        // 「创建BM」弹窗的组合动作：建 BM →（可选）建广告号 →（可选）建主页，
        // 三步必须按顺序在同一项里完成，所以做成一个组合 op，而不是拆成三个队列任务
        create_bm_bundle: {
            label: '创建BM（含广告号/主页）',
            run: async (item, { signal, hasNextForProfile }) => {
                const p = item.payload;
                const pid = p.profileId;
                // 🔁 同 create_bm：先借用启动（子接口 business/create、create-adaccount、
                //    pages/create-and-grant 全部走复用路径，bundle 内部不再反复开关浏览器）
                // ⚠️ 不传 maxMs：bundle 含邀请链接收信轮询（45s/个）+上架，6 分钟硬上限必杀在半路
                //    且强杀丢 Cookie（同 create_bm 处的注释）
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    return await _runCreateBmBundle(item, { signal, hasNextForProfile }, startedByUs, pid);
                } finally {
                    if (!(hasNextForProfile && await hasNextForProfile(pid))) {
                        await releaseBorrowed(pid, startedByUs);
                    } else {
                        _log('INFO', `🔁 [JobQueue] ${pid} 还有同号后续任务，浏览器保留给下一项复用`);
                    }
                }
            },
        },
        // 📧 批量生成邀请链接（BM 批量操作 →「邀请用户」的自动模式）：
        //    每个队列项 = 一个 BM，为该 BM 生成 N 个邀请链接（N 由 payload.count 指定）。
        generate_invite_links: {
            label: '生成邀请链接',
            // 🔁 同 create_bm：借用模型 + 同号连续任务复用浏览器
            // ⚠️ 不传 maxMs：收信轮询 45s/个 + 上架，6 分钟硬上限会杀在半路且强杀丢 Cookie
            run: async (item, { signal, hasNextForProfile }) => {
                const p = item.payload;
                const pid = p.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    const r = await call('/api/facebook/business/generate-invite-links', {
                        profileId: p.profileId,
                        businessId: p.businessId,
                        count: Number(p.count) || 1,
                        role: p.role || 'employee',
                        pollSeconds: p.pollSeconds || 45,
                        // 🛒 自动上架商城联动（勾选时透传，未勾为 undefined=不上架）
                        shopPublish: p.shopPublish,
                        shopPrice: p.shopPrice,
                        shopCurrency: p.shopCurrency,
                    }, signal).catch(() => null);
                    if (!r || !r.success) return norm(r, '生成邀请链接失败');
                    return {
                        success: true,
                        message: `BM ${p.businessId}：${r.message || `邀请链接 ${r.generated}/${r.requested} 个已生成`}`,
                        raw: r,
                    };
                } finally {
                    if (hasNextForProfile && await hasNextForProfile(pid)) {
                        _log('INFO', `🔁 [JobQueue] ${pid} 还有同号后续任务，浏览器保留给下一项复用`);
                    } else {
                        await releaseBorrowed(pid, startedByUs);
                    }
                }
            },
        },
        // 📧 批量生成邀请链接并写入商城商品（整批共用一个商品）
        //    payload: {
        //      targets:[{ profileId, businessId }],   // 整批的 BM
        //      count, role, pollSeconds?,
        //      productId?, product?,                  // 已有商品：更新它（product 传完整字段）
        //      productTitle?, blockId?                // 无 productId：按标题在指定板块新建商品
        //    }
        //    存储格式：每组 = 「BMID」换行 该 BM 的所有链接（相同 BMID 的多条链接归为一组），
        //              组间空行，整段写进商品的 invite_link；商品数量(stock) = 成功生成的组数。
        //    ⚠️ 必须聚合成**一个队列项**：多个 BM 若各自开一项并发写同一个商品，会互相覆盖。
        generate_invite_links_to_product: {
            label: '生成邀请链接并写入商品',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const targets = Array.isArray(p.targets) ? p.targets : [];
                if (!targets.length) return { success: false, message: '没有目标 BM' };
                const count = Math.max(1, Math.min(Number(p.count) || 1, 10));
                const groups = [];
                for (const t of targets) {
                    const r = await call('/api/facebook/business/generate-invite-links', {
                        profileId: t.profileId, businessId: t.businessId,
                        count, role: p.role || 'employee', pollSeconds: p.pollSeconds || 45,
                    }, signal).catch(() => null);
                    // 保留邮箱：商品里要同时给出「临时邮箱 + 邀请链接」，买家按邮箱对照领取
                    const items = (r && Array.isArray(r.links) ? r.links : [])
                        .map((x) => ({ email: String((x && x.email) || ''), link: String((x && x.inviteLink) || '') }))
                        .filter((x) => x.link);
                    groups.push({ bmId: String(t.businessId), items });
                }
                const withLinks = groups.filter((g) => g.items.length);
                const total = withLinks.reduce((n, g) => n + g.items.length, 0);
                const summary = `生成 ${total} 条链接，覆盖 ${withLinks.length}/${groups.length} 个 BM（商品数量=${withLinks.length}）`;
                if (!total) return { success: false, message: `${summary}（没有可用链接，未写商品）` };
                // 分组文本：每组 = BMID 换行 (邮箱 换行 链接)…；组间空行
                const text = withLinks
                    .map((g) => [g.bmId, ...g.items.flatMap((it) => (it.email ? [it.email, it.link] : [it.link]))].join('\n'))
                    .join('\n\n');
                // 写商城商品（条目制）：每个链接一条 shop_product_items（一个 BMID = 一组数量，库存=条目数自动）。
                // 🐛 不能把选中商品原样透传（body = {...p.product, invite_link, stock}）：
                //    admin/products 返回的商品自带 items 数组，透传后云端 save 检测到 body.items
                //    误入「条目重建」分支——旧条目原样回写、新链接只写进主表 invite_link 文本列、
                //    条目表一字未动、stock 按旧条目数重算 → 任务显示「已写入商品」但商城看不到任何新链接。
                //    ✅ 已有商品走 itemsMerge 追加（只插云端没有的链接，不动主字段，与 invite-user
                //    自动上架同语义）；新建商品直接带 items 条目制插入。
                const newItems = groups.flatMap((g) => g.items.map((it) => ({ bm_id: g.bmId, invite_link: it.link })));
                let body;
                if (p.productId) {
                    // ⚠️ title 必填：云端 save 在进 itemsMerge 分支**之前**就校验 title 并 400，
                    //    所以即使 itemsMerge 不更新主字段，body 也必须带 title（选已有商品时=原标题）
                    body = { id: Number(p.productId), title: p.productTitle || `BM 邀请链接 ${new Date().toLocaleString('zh-CN')}`, itemsMerge: true, items: newItems };
                } else {
                    body = {
                        title: p.productTitle || `BM 邀请链接 ${new Date().toLocaleString('zh-CN')}`,
                        product_type: 'bm', price: 0, currency: 'USDT',
                        block_id: p.blockId === undefined ? null : (Number(p.blockId) || null),
                        items: newItems,
                    };
                }
                const saved = await call('/api/shop/save-product', body, signal).catch((e) => ({ success: false, message: (e && e.message) || String(e) }));
                if (!saved || saved.success === false) {
                    // 把云端返回的 error 一并透出：云端只回「保存失败」时根本看不出原因（DB 约束/字段长度等）
                    const why = [(saved && saved.message) || '未知原因', (saved && saved.error) ? String(saved.error) : ''].filter(Boolean).join('｜');
                    return { success: false, message: `${summary}；但写入商品失败：${why}`, raw: { groups, sent: body } };
                }
                const mergedNote = saved.merged ? `，新增条目 ${saved.added}，跳过重复 ${saved.skipped}` : '';
                return {
                    success: true,
                    message: `${summary}；已写入商品「${body.title || p.productTitle || `#${saved.id}`}」${mergedNote}\n\n${text}`,
                    raw: { groups, productId: saved.id || p.productId || null, sent: body },
                };
            },
        },
        // 📌 授权主页给 BM（纯 Graph 调用，不需要浏览器）
        grant_page: {
            label: '授权主页',
            run: async (item, { signal }) => norm(await call('/api/facebook/businesses/grant-page', item.payload, signal), '主页已授权给 BM'),
        },
        // 🤝 分享广告号给合作伙伴 BM（纯 Graph 调用）
        share_partner: {
            label: '分享合作伙伴',
            run: async (item, { signal }) => norm(await call('/api/facebook/adaccounts/share-to-partner', item.payload, signal), '已分享给合作伙伴 BM'),
        },
        // 🎯 创建像素：对目标广告号逐个创建（目标来自 payload.adAccountIds，缺省则由后端从 BM 自动拉取）
        //    原前端是「先 refresh-info 取广告号 → 再逐个 pixel/create」的双层循环，这里原样搬进队列，
        //    避免刷新/关弹窗丢进度，也避免多个 BM 同时在前端开并发窗口。
        create_pixel: {
            label: '创建像素',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                let targets = Array.isArray(p.adAccountIds)
                    ? p.adAccountIds.map(a => String(a).replace(/^act_/, '')).filter(Boolean)
                    : [];
                if (targets.length === 0) {
                    if (!p.businessId) return { success: false, message: '未指定广告号，且缺少 businessId 无法自动拉取' };
                    const info = await call('/api/facebook/businesses/refresh-info', { profileId: p.profileId, businessId: p.businessId }, signal);
                    if (!info || !info.success) return norm(info, '');
                    targets = Array.from(new Set((Array.isArray(info.adAccounts) ? info.adAccounts : [])
                        .map((a) => String(a.accountId || a.id || '').replace(/^act_/, '')).filter(Boolean)));
                    if (targets.length === 0) return { success: false, message: '该 BM 名下没有广告号' };
                }
                let ok = 0, claimFail = 0;
                const failed = [];
                for (const actId of targets) {
                    try {
                        const doClaim = !!p.claimToBusiness && !!p.businessId;
                        const json = await call('/api/facebook/adaccounts/pixel/create', {
                            profileId: p.profileId,
                            adAccountId: actId,
                            name: p.pixelName || `pixel_${actId}`,
                            ...(doClaim ? { businessId: p.businessId, claimToBusiness: true } : {}),
                        }, signal);
                        if (json && json.success) { ok++; if (json.claim && json.claim.success === false) claimFail++; }
                        else failed.push(`${actId}: ${(json && (json.message || json.error)) || '失败'}`);
                    } catch (e) { failed.push(`${actId}: ${(e && e.message) || '网络错误'}`); }
                }
                const msg = `像素创建 ${ok}/${targets.length} 成功`
                    + (p.claimToBusiness && ok > 0 ? `（认领到 BM ${ok - claimFail}/${ok}）` : '')
                    + (failed.length ? `\n失败: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ` …等 ${failed.length} 个` : ''}` : '');
                return { success: failed.length === 0, message: msg, raw: { ok, total: targets.length, failed } };
            },
        },
        // 💳 绑卡（Puppeteer 重活，必须浏览器）：借用 → 执行 → 归还。
        //    ⏱️ 6 分钟借用上限：导航 + 取 dtsg/session + 提交卡片本身就要 1~2 分钟，
        //       用默认 90s 硬上限会被中途强杀。
        bind_card: {
            label: '绑卡',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal, { maxMs: 360000 });
                try {
                    return norm(await call('/api/facebook/billing/bind-card-puppeteer', item.payload, signal), '绑卡完成');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        // 🛡️ BM 认证（Puppeteer 重活，必须浏览器）：借用 → 执行 → 归还（上传文件 + 填表，给 6 分钟）
        verify_bm: {
            label: 'BM认证',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal, { maxMs: 360000 });
                try {
                    return norm(await call('/api/facebook/businesses/verify-puppeteer', item.payload, signal), 'BM 认证已提交');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        // 📧 邀请用户（手动填邮箱，可一次多个）：纯 Graph 调用
        invite_users: {
            label: '邀请用户',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const json = await call('/api/facebook/businesses/invite-user', p, signal);
                if (!json || !json.success) return norm(json, '');
                const list = Array.isArray(json.results) ? json.results : [];
                const ok = list.filter((r) => r && r.status === 'success').length;
                const fail = list.filter((r) => r && r.status !== 'success');
                const msg = `邀请 ${ok}/${list.length || (p.emails || []).length} 个邮箱成功`
                    + (fail.length ? `\n失败: ${fail.slice(0, 3).map((r) => `${r.email}: ${r.message}`).join('; ')}${fail.length > 3 ? ` …等 ${fail.length} 个` : ''}` : '');
                return { success: fail.length === 0, message: msg, raw: json };
            },
        },
        // 👤 广告号授权个号（BM 操作弹窗）：支持传 adAccountIds，或由后端按 businessId 自动拉取
        assign_personal_ad: {
            label: '广告号授权个号',
            run: async (item, { signal }) => norm(await call('/api/facebook/adaccounts/assign-personal', item.payload, signal), '广告号已授权给个人号'),
        },
        // 👤 主页授权个号（BM 操作弹窗）：支持传 pageIds，或由后端按 businessId 自动拉取
        grant_personal_page: {
            label: '主页授权个号',
            run: async (item, { signal }) => norm(await call('/api/facebook/pages/grant-personal', item.payload, signal), '主页已授权给个人号'),
        },
        // 🔄 刷新 BM 信息：把原来前端拼的「名称/认证/广告号/主页」明细在 op 里拼好，队列项直接可读
        refresh_info: {
            label: '刷新信息',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const json = await call('/api/facebook/businesses/refresh-info', { profileId: p.profileId, businessId: p.businessId }, signal);
                if (!json || !json.success) return norm(json, '');
                let msg = `BM: ${json.name || p.businessId} | 认证: ${json.verification_status || '未知'}`;
                msg += ` | 广告号: ${json.adAccountsCount ?? 0} 个 | 主页: ${json.pagesCount ?? 0} 个`;
                if (Array.isArray(json.adAccounts) && json.adAccounts.length) {
                    msg += `\n广告号: ${json.adAccounts.slice(0, 5).map((a) => `${a.accountId || a.id}(${a.name || ''})`).join(', ')}${json.adAccounts.length > 5 ? `...等${json.adAccounts.length}个` : ''}`;
                }
                if (Array.isArray(json.pages) && json.pages.length) {
                    msg += `\n主页: ${json.pages.slice(0, 5).map((x) => `${x.id}(${x.name || ''})`).join(', ')}${json.pages.length > 5 ? `...等${json.pages.length}个` : ''}`;
                }
                return { success: true, message: msg, raw: json };
            },
        },
        // 🔐 同步 BM 全部权限
        sync_permissions: {
            label: '同步权限',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const json = await call('/api/facebook/businesses/sync-permissions', { profileId: p.profileId, businessId: p.businessId }, signal);
                if (!json || !json.success) return norm(json, '');
                const adTotal = json.adAccounts?.total ?? 0;
                const adOk = (json.adAccounts?.results || []).filter((r) => r && r.success).length;
                const pageTotal = json.pages?.total ?? 0;
                const pageOk = (json.pages?.results || []).filter((r) => r && r.success).length;
                let msg = `同步完成 | 广告号: ${adOk}/${adTotal} 成功 | 主页: ${pageOk}/${pageTotal} 成功`;
                const failedAds = (json.adAccounts?.results || []).filter((r) => r && !r.success);
                const failedPages = (json.pages?.results || []).filter((r) => r && !r.success);
                if (failedAds.length) msg += `\n广告号失败: ${failedAds.slice(0, 3).map((r) => `${r.accountId || r.id}: ${r.error || r.message || ''}`).join(', ')}`;
                if (failedPages.length) msg += `\n主页失败: ${failedPages.slice(0, 3).map((r) => `${r.id}: ${r.error || r.message || ''}`).join(', ')}`;
                return { success: true, message: msg, raw: json };
            },
        },
        // 🎯 像素授权：mode='partner' → 分享给合作方 BM；否则 → 关联到广告号
        grant_pixels: {
            label: '像素授权',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const isPartner = p.mode === 'partner';
                const path = isPartner ? '/api/facebook/pixels/share-to-partner' : '/api/facebook/pixels/assign-to-adaccounts';
                const body = isPartner
                    ? { profileId: p.profileId, pixelIds: p.pixelIds, partnerBusinessId: p.partnerBusinessId, tasks: p.tasks }
                    : { profileId: p.profileId, businessId: p.businessId, pixelIds: p.pixelIds, adAccountIds: p.adAccountIds };
                const json = await call(path, body, signal);
                if (!json || !json.success) return norm(json, '');
                const list = Array.isArray(json.results) ? json.results : [];
                const pending = list.filter((r) => r && r.pending).length;
                const failed = list.filter((r) => r && r.status !== 'success');
                const msg = (json.message || '像素授权完成')
                    + (pending ? `\n${pending} 个已发共享协议，等对方 BM 接受后生效` : '')
                    + (failed.length ? `\n失败: ${failed.slice(0, 3).map((r) => `${r.pixelId}${r.adAccountId ? `→${r.adAccountId}` : ''}: ${r.message}`).join('; ')}${failed.length > 3 ? ` …等 ${failed.length} 条` : ''}` : '');
                return { success: failed.length === 0, message: msg, raw: json };
            },
        },
        create_page: {
            label: '创建主页',
            run: async (item, { signal }) => norm(await call('/api/facebook/pages/create', item.payload, signal), `主页「${item.payload.name}」已创建`),
        },
        fetch_tokens: {
            label: '获取TOKEN',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    const res = await call('/api/facebook/tokens', { profileId: pid, targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' }, signal);
                    if (res && res.success && res.tokens) {
                        await call('/api/facebook/save-tokens', { profileId: pid, tokens: res.tokens }, signal).catch(() => null);
                        return { success: true, message: `配置 ${pid} TOKEN 已获取并保存`, raw: res };
                    }
                    return norm(res, '');
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        relogin: {
            label: '批量重登',
            run: async (item, { signal }) => {
                const pid = item.payload.profileId;
                const startedByUs = await borrowLaunch(pid, signal);
                try {
                    return norm(await call('/api/facebook/relogin', { profileId: pid }, signal), `配置 ${pid} 已重新登录`);
                } finally {
                    await releaseBorrowed(pid, startedByUs);
                }
            },
        },
        create_adaccount: {
            label: '创建广告号',
            // 🔁 同 create_bm：借用模型 + 同号连续任务复用浏览器（避免每个广告号都冷启动一次）
            run: async (item, { signal, hasNextForProfile }) => {
                const p = item.payload || {};
                const pid = p.profileId;
                const startedByUs = await borrowLaunch(pid, signal, { maxMs: 360000 });
                try {
                    const j = await call('/api/facebook/businesses/create-adaccount', p, signal);
                    const r = norm(j, `广告号「${p.adNameManual || p.name || item.label || ''}」已创建`);
                    // 🆕 把新建广告号的 ID 拼进 message —— 智能发布要靠它把「刚建出来的广告号」
                    //    接给后面的绑卡/发布步骤（队列项只回传 message，raw 会被丢弃）。
                    const ids = ((j && j.accounts) || [])
                        .map((a) => String((a && (a.accountId || a.id)) || '').replace(/^act_/, ''))
                        .filter(Boolean);
                    if (ids.length) r.message = `广告号已创建：act_${ids.join('、act_')}`;
                    return r;
                } finally {
                    if (hasNextForProfile && await hasNextForProfile(pid)) {
                        _log('INFO', `🔁 [JobQueue] ${pid} 还有同号后续任务，浏览器保留给下一项复用`);
                    } else {
                        await releaseBorrowed(pid, startedByUs);
                    }
                }
            },
        },
        // 🔑 授权到个人号：一个 item = 一个「资产所属配置」，payload.assetIds 是它名下要授权的资产。
        //    放在队列里跑的原因跟发布广告一样：授权要开着那个配置的浏览器、走 FB 内部接口，
        //    单个 2~5s，批量几十个就是分钟级 —— 前端刷新/切页/断网都不该把它打断。
        grant_personal: {
            label: '授权到个人号',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const isPage = p.mode === 'page';
                let json;
                if (isPage) {
                    // 主页：没有「从配置选个人号」这条路，只能传解析好的 fbUserId
                    json = await call('/api/facebook/pages/grant-personal', {
                        profileId: p.ownerProfileId, pageIds: p.assetIds, fbUserId: p.fbUserId,
                    }, signal);
                } else if (p.personalProfileId) {
                    // 广告号 + 从配置选个人号 → 完整版（支持同时加好友，fbUserId 由后端从 Cookie 解析）
                    json = await call('/api/facebook/adaccounts/assign-personal-full', {
                        ownerProfileId: p.ownerProfileId,
                        personalProfileId: p.personalProfileId,
                        adAccountIds: p.assetIds,
                        addFriend: !!p.addFriend,
                        role: p.role || 'ADMIN',
                    }, signal);
                } else {
                    json = await call('/api/facebook/adaccounts/assign-personal', {
                        profileId: p.ownerProfileId, fbUserId: p.fbUserId, adAccountIds: p.assetIds, role: p.role || 'ADMIN',
                    }, signal);
                }

                const list = Array.isArray(json && json.results) ? json.results : [];
                const okCount = list.filter((r) => r.status === 'success').length;
                const failList = list.filter((r) => r.status !== 'success');
                // 加好友结果单独报一句（授权失败但好友加上了，也是真实发生的事，不该被吞掉）
                const friends = Array.isArray(json && json.friendResults) ? json.friendResults : [];
                const friendOk = friends.filter((f) => ['sent', 'accepted', 'already_friends', 'pending'].includes(f.status)).length;
                const suffix = friends.length ? ` · 加好友 ${friendOk}/${friends.length}` : '';
                const warn = (json && Array.isArray(json.warnings) && json.warnings.length) ? ` · ${json.warnings.join('；')}` : '';

                if (json && json.success) {
                    return {
                        success: true,
                        message: `授权完成 ${okCount}/${list.length || p.assetIds.length}${suffix}${warn}`,
                        raw: json,
                    };
                }
                const why = failList.length
                    ? failList.map((r) => `${r.adAccountId || r.pageId || ''}: ${r.message}`).join('；')
                    : (json && (json.message || json.error)) || '接口未返回 success';
                return { success: false, message: String(why).slice(0, 300), raw: json };
            },
        },
        // 🎯 同意主页管理员邀请：授权到个号发完邀请后，由「受邀方配置」的浏览器去点同意。
        //    走 FB 内部 GraphQL（先打开邀请页取 profile_admin_invite_id，再发 mutation），
        //    慢在开浏览器 + 等页面渲染，所以同样丢给队列。
        accept_page_invite: {
            label: '同意主页邀请',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const json = await call('/api/facebook/pages/accept-admin-invite', {
                    profileId: p.profileId, pageIds: p.pageIds,
                }, signal);

                const list = Array.isArray(json && json.results) ? json.results : [];
                const okCount = list.filter((r) => r.status === 'accepted').length;
                const total = list.length || (Array.isArray(p.pageIds) ? p.pageIds.length : 0);

                if (json && json.success) {
                    return {
                        success: true,
                        message: `配置 ${p.profileId} 已同意 ${okCount}/${total} 个主页邀请`,
                        raw: json,
                    };
                }
                const why = list.filter((r) => r.status !== 'accepted').map((r) => `${r.pageId}: ${r.message}`).join('；')
                    || (json && (json.message || json.error)) || '接口未返回 success';
                return { success: false, message: String(why).slice(0, 300), raw: json };
            },
        },
        // 📤 发布 / 取消发布主页：和「授权到个人号」同一种形态 —— 一个 item = 一个配置下的一批主页。
        //    慢在「要拿配置的 token 逐个调 FB」，所以同样丢给队列，前端只提交 + 看进度。
        publish_pages: {
            label: '发布/取消发布主页',
            run: async (item, { signal }) => {
                const p = item.payload || {};
                const target = p.publish !== false;
                const json = await call('/api/facebook/pages/publish', {
                    profileId: p.profileId, pageIds: p.pageIds, publish: target,
                }, signal);

                const list = Array.isArray(json && json.results) ? json.results : [];
                const okCount = list.filter((r) => r.status === 'success').length;
                const total = list.length || (Array.isArray(p.pageIds) ? p.pageIds.length : 0);

                if (json && json.success) {
                    return {
                        success: true,
                        message: `配置 ${p.profileId} ${target ? '发布' : '取消发布'} ${okCount}/${total} 个主页`,
                        raw: json,
                    };
                }
                const why = list.filter((r) => r.status !== 'success').map((r) => `${r.pageId}: ${r.message}`).join('；')
                    || (json && (json.message || json.error)) || '接口未返回 success';
                return { success: false, message: String(why).slice(0, 300), raw: json };
            },
        },
        publish_ads: {
            label: '发布广告',
            run: async (item, { signal, shared }) => {
                const profileId = String(item.payload.profileId);
                // 公共负载（campaignTree + 素材 base64 等）整批只下发一份，这里按配置合并
                const body = { ...(shared || {}), ...item.payload, profileId };
                // 与界面「发布广告」弹窗行为保持一致：puppeteer 模式先确保该配置浏览器已启动
                if (body.publishMethod === 'puppeteer') {
                    await call('/api/launch-browser', { profileId }, signal).catch(() => null);
                }
                const json = await call('/api/facebook/publish-ad', body, signal);
                // 🆕 「跳过」要分两种，不能一律报成功：
                //    · skipReason='已有广告' → 预期行为（不重复发），算成功；
                //    · 其余（Token 失效 / 无权访问广告账户）→ 一条都没发出去，必须报失败，
                //      否则界面上会出现「发布成功 0/0」这种误导结果。
                if (json && json.skipped) {
                    if (json.skipReason === '已有广告') {
                        return { success: true, message: `跳过发布：该账户已有广告（未重复发）`, raw: json };
                    }
                    const why = String(json.message || json.error || '未说明原因').slice(0, 200);
                    return { success: false, message: `已跳过（未发布）：${why}`, raw: json };
                }
                if (json && json.success) {
                    return { success: true, message: `配置 ${profileId} 发布完成：成功 ${json.successCount || 0}/${json.total || 0} 条`, raw: json };
                }
                return norm(json, '');
            },
        },
        // 🧠 「智能发布」组合任务：把一个配置的整条步骤流水线放到后端跑（前端只提交 + 看进度）。
        //    ⚠️ 分 3 批迁移：本批已实现 fetchInfo / token / checkLogin / lang / payment / checkCard；
        //       其余步骤（precheck / billing / card / page / checkAd / publish）会在后续批次补上，
        //       未实现的步骤只记一条「暂未接入」到结果里，不会误当做成功。
        smart_publish_bundle: {
            label: '智能发布（组合步骤）',
            run: async (item, { signal, shared }) => {
                const p = item.payload || {};
                const pid = String(p.profileId || '');
                // 公共配置整批共用一份（账单参数/卡片池/主页模板含图片 base64/代理池）
                const cfg = (shared && shared.config) || p.config || {};
                const steps = Array.isArray(p.steps) ? p.steps : [];
                const accIds = Array.isArray(p.adAccountIds) ? p.adAccountIds.map(String) : [];
                const notes = [];
                const proxyFailed = [];     // 失败代理的 id（返回给前端去标记，避免把云端的 auth token 存进队列库）
                let launchedByUs = false;   // 本次是否由我们启动的浏览器（已在运行的复用实例不动它）
                let skipCard = false;       // checkCard 发现已有卡片 → 后续 card 步骤跳过
                let aborted = false;        // 登录/Token 失效 → 该配置剩余步骤全部跳过
                let failed = false;         // 真的出问题了（登录失败/Token 过期/预检不过）→ 该项计为失败
                if (!pid) return { success: false, message: '缺少 profileId' };

                // 🕒 关浏览器不带任务的 signal：即使任务被取消也要把浏览器还掉
                const closeBrowser = async () => {
                    if (!launchedByUs) return;
                    launchedByUs = false;
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 15000);
                    try { await call('/api/facebook/close-browser', { profileId: pid }, ctrl.signal).catch(() => { }); } finally { clearTimeout(timer); }
                };
                // 步骤之间浏览器要常驻：已运行会复用（reused=true，不计入"我们启动的"）
                const ensureBrowser = async (extra = {}) => {
                    const l = await call('/api/launch-browser', { profileId: pid, ...extra }, signal).catch(() => null);
                    const reused = !!(l && l.data && l.data.reused);
                    if (l && l.success && !reused) launchedByUs = true;
                    return !!(l && l.success);
                };
                // 🚩 标记失败代理：先记在本项结果里，再（若前端下发了云端地址+token）直接调云端接口持久化。
                //    云端地址/token 由前端放进 shared.cloud —— 队列项只回传 message，raw 会被丢弃，
                //    所以想让「失败代理」落到云端库，只能由服务端自己发这个请求。
                const cloud = (shared && shared.cloud) || {};
                const markProxyFailed = async (proxyId) => {
                    if (!proxyId) return;
                    if (!proxyFailed.includes(proxyId)) proxyFailed.push(proxyId);
                    if (!cloud.base || !cloud.token) return;
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 15000);
                    try {
                        // ⚠️ 云端真实路由是 POST /api/proxies/:id/fail（路径里带 id），
                        //    不是 /api/proxies/fail + body —— 前端以前调错了，一直是 404 静默失败。
                        await fetch(`${String(cloud.base).replace(/\/$/, '')}/api/proxies/${encodeURIComponent(proxyId)}/fail`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.token}` },
                            signal: ctrl.signal,
                        });
                    } catch { /* 标记失败不影响主流程 */ } finally { clearTimeout(timer); }
                };

                try {
                    for (const sk of steps) {
                        if (aborted) { notes.push(`${sk}: 已中止，跳过`); continue; }
                        if (sk === 'fetchInfo') {
                            await ensureBrowser();
                            await sleep(3000);
                            const j = await call('/api/facebook/fetch-adaccounts-graph', { profileId: pid, accessToken: 'BROWSER' }, signal);
                            notes.push(j && j.success
                                ? `获取信息 ✅ 广告号=${j.count || 0} 主页=${j.pagesCount || 0} 像素=${j.pixelsCount || 0}`
                                : `获取信息 ❌ ${(j && j.message) || '未知错误'}`);
                            await closeBrowser();
                        } else if (sk === 'token') {
                            await ensureBrowser();
                            const j = await call('/api/facebook/fetch-adaccounts-graph', { profileId: pid, accessToken: 'BROWSER' }, signal);
                            notes.push(j && j.success ? 'Token ✅ 已刷新' : `Token ❌ ${(j && j.message) || '未知错误'}`);
                        } else if (sk === 'checkLogin') {
                            await ensureBrowser();
                            await sleep(5000);
                            let j = await call('/api/facebook/check-login', { profileId: pid }, signal).catch(() => null);
                            let ok = !!(j && j.loggedIn);
                            if (!ok) {
                                await call('/api/facebook/auto-login', { profileId: pid }, signal).catch(() => null);
                                await sleep(8000);
                                j = await call('/api/facebook/check-login', { profileId: pid }, signal).catch(() => null);
                                ok = !!(j && j.loggedIn);
                            }
                            await closeBrowser();
                            notes.push(ok ? '登录状态 ✅' : '登录状态 ❌');
                            if (!ok) { aborted = true; failed = true; notes.push('🚫 登录失败，停止该配置剩余步骤'); }
                        } else if (sk === 'lang') {
                            if (!accIds.length) { notes.push('语言: 无广告号'); continue; }
                            await ensureBrowser();
                            for (const accId of accIds) {
                                const j = await call('/api/facebook/adaccounts/change-currency-timezone', { profileId: pid, adAccountId: accId, lang: cfg.lang }, signal);
                                if (j && j.loginFailed) {
                                    aborted = true; failed = true; notes.push(`🚫 ${accId}: Token 已过期，停止剩余步骤`); await closeBrowser(); break;
                                }
                                notes.push(`${accId}: 语言=${cfg.lang || ''} ${j && j.success ? '✅' : `❌ ${(j && j.message) || ''}`}`);
                            }
                        } else if (sk === 'payment') {
                            if (!accIds.length) { notes.push('手动付款: 无广告号'); continue; }
                            await ensureBrowser();
                            const amt = String(cfg.paymentAmount || '');
                            for (const accId of accIds) {
                                const j = await call('/api/facebook/billing/manual-payment', { profileId: pid, adAccountId: accId, amount: amt }, signal);
                                if (j && j.loginFailed) {
                                    aborted = true; failed = true; notes.push(`🚫 ${accId}: Token 已过期，停止剩余步骤`); await closeBrowser(); break;
                                }
                                notes.push(`${accId}: 付款 $${amt} ${j && j.success ? '✅' : `❌ ${(j && j.message) || ''}`}`);
                            }
                        } else if (sk === 'checkCard') {
                            if (!accIds.length) { notes.push('检查卡片: 无广告号'); continue; }
                            await ensureBrowser();
                            let any = false;
                            for (const accId of accIds) {
                                const j = await call('/api/facebook/billing/cards', { profileId: pid, adAccountId: accId }, signal);
                                if (j && j.loginFailed) {
                                    aborted = true; failed = true; notes.push(`🚫 ${accId}: Token 已过期，停止剩余步骤`); await closeBrowser(); break;
                                }
                                const n = j && Array.isArray(j.methods) ? j.methods.length : 0;
                                if (n > 0) { any = true; notes.push(`${accId}: 已有 ${n} 张卡片`); }
                                else notes.push(`${accId}: 未发现卡片`);
                            }
                            if (any) { skipCard = true; notes.push('🚀 标记后续跳过绑卡步骤'); }
                        } else if (sk === 'billing') {
                            if (!accIds.length) { notes.push('账单国家/时区: 无广告号'); continue; }
                            await ensureBrowser();
                            const b = cfg.billing || {};
                            // 已经是目标值的不必再改（前端把各广告号当前值放在 adAccountMeta 里下发）
                            const meta = Array.isArray(p.adAccountMeta) ? p.adAccountMeta : [];
                            const need = [];
                            for (const accId of accIds) {
                                const clean = String(accId).replace(/^act_/, '');
                                const found = meta.find((m) => String(m.adAccountId || m.account_id || '').replace(/^act_/, '') === clean);
                                if (!found) { need.push(accId); continue; }
                                const ccyOk = String(found.currency || '').toUpperCase() === String(b.currency || '').toUpperCase();
                                const tzOk = String(found.timezone_id || '') === String(b.timezone_id || '');
                                const countryOk = String(found.business_country_code || found.country || '').toUpperCase() === String(b.country || '').toUpperCase();
                                if (ccyOk && tzOk && countryOk) { notes.push(`${accId}: 货币/时区/国家已是目标值，跳过`); continue; }
                                need.push(accId);
                            }
                            if (!need.length) { notes.push('账单：所有广告号已是最新，无需修改'); continue; }
                            const j = await call('/api/facebook/adaccounts/change-currency-timezone', {
                                profileId: pid, adAccountIds: need,
                                currency: b.currency, timezone_id: b.timezone_id, country: b.country, lang: b.lang,
                                address: b.address, city: b.city, zip: b.zip, state: b.state,
                                business_name: b.business_name || undefined,
                            }, signal);
                            if (j && j.loginFailed) {
                                aborted = true; failed = true; notes.push('🚫 Token 已过期，停止剩余步骤'); await closeBrowser();
                            } else if (j && Array.isArray(j.results)) {
                                j.results.forEach((r) => notes.push(`${r.adAccountId}: ${r.success ? '✅' : '❌'} ${r.message || ''}`));
                                notes.push(`账单批量完成: ${j.completed || 0}/${j.total || need.length}`);
                            } else {
                                notes.push(`账单更新返回异常: ${(j && j.message) || '未知'}`);
                            }
                        } else if (sk === 'card') {
                            if (skipCard) { notes.push('检查发现已有卡片，跳过绑卡'); continue; }
                            if (!accIds.length) { notes.push('绑卡: 无广告号'); continue; }
                            const cards = Array.isArray(cfg.cards) ? cfg.cards.filter(Boolean) : [];
                            if (!cards.length) { notes.push('绑卡: 未选择卡片'); continue; }
                            await ensureBrowser();
                            const b = cfg.billing || {};
                            const cycleMode = cfg.cardIterateMode === 'cycle';
                            let cardLoginFailed = false;
                            const doBind = async (cid, card) => {
                                const j = await call('/api/facebook/billing/add', {
                                    profileId: pid,
                                    adAccountId: cid,
                                    mode: 'manual',
                                    card: {
                                        number: card.number, holder: card.holder || '',
                                        exp_month: card.expMonth, exp_year: card.expYear, cvv: card.cvv || '',
                                        billing_address: b.address, city: b.city, zip: b.zip, state: b.state,
                                        country_code: b.country,
                                    },
                                    channel: card.channel || 'ali',
                                    tag: card.tag || '',
                                    currency: b.currency,
                                    timezone_id: b.timezone_id,
                                    country_code: b.country,
                                    checkBillingParams: cfg.checkBillingParams,
                                }, signal);
                                if (j && j.loginFailed) {
                                    cardLoginFailed = true;
                                    notes.push(`🚫 ${cid}: Token 已过期，停止该配置剩余步骤`);
                                    return;
                                }
                                notes.push(`${cid}: 绑卡 ${j && j.success ? '✅' : `❌ ${(j && j.message) || ''}`}`);
                            };
                            if (cycleMode) {
                                for (let ci = 0; ci < accIds.length; ci++) {
                                    if (cardLoginFailed) break;
                                    await doBind(accIds[ci], cards[ci % cards.length]);
                                }
                            } else {
                                for (const accId of accIds) {
                                    if (cardLoginFailed) break;
                                    let bound = false;
                                    for (const card of cards) {
                                        if (bound) break;
                                        await doBind(accId, card);
                                        if (cardLoginFailed) break;
                                        // 复核：用卡片列表接口确认这张卡真的生效了
                                        const j = await call('/api/facebook/billing/cards', { profileId: pid, adAccountId: accId }, signal).catch(() => null);
                                        const list = j && Array.isArray(j.methods) ? j.methods : [];
                                        const ok = list.some((m) => {
                                            const ml4 = String(m.last4 || '').slice(-4);
                                            const cl4 = String(card.last4 || card.number || '').slice(-4);
                                            return !!(ml4 && cl4 && ml4 === cl4);
                                        });
                                        if (ok) { notes.push(`${accId}: 绑卡生效 ✅`); bound = true; }
                                        else { notes.push(`${accId}: 该卡未生效，尝试下一张…`); await sleep(5000); }
                                    }
                                    // 下一步不是发布/设置限额就先归还浏览器（省并发名额）；是则保持打开
                                    const nextSk = steps[steps.indexOf(sk) + 1];
                                    if (nextSk !== 'publish' && nextSk !== 'spendCap') await closeBrowser();
                                }
                            }
                            if (cardLoginFailed) { aborted = true; failed = true; await closeBrowser(); }
                        } else if (sk === 'spendCap') {
                            // 💰 绑卡之后设置「账户花费上限」(spend_cap)：
                            //    按账户货币主单位原值提交（界面输入多少就提交多少），逐个广告号写入。
                            if (!accIds.length) { notes.push('限额: 无广告号'); continue; }
                            const capRaw = String(cfg.spendCap ?? '').trim();
                            const cap = Number(capRaw);
                            if (capRaw === '' || !Number.isFinite(cap) || cap < 0) { notes.push(`限额: 数值无效 ${capRaw || '(空)'}`); continue; }
                            await ensureBrowser();
                            for (const accId of accIds) {
                                const j = await call('/api/facebook/adaccounts/spend-cap', { profileId: pid, adAccountId: accId, spend_cap: cap }, signal);
                                if (j && j.loginFailed) {
                                    aborted = true; failed = true; notes.push(`🚫 ${accId}: Token 已过期，停止剩余步骤`); await closeBrowser(); break;
                                }
                                notes.push(`${accId}: 限额=${cap} ${j && j.success ? '✅' : `❌ ${(j && j.message) || ''}`}`);
                            }
                        } else if (sk === 'page') {
                            const pg = cfg.page;
                            if (!pg || !pg.name || !pg.categoryId) { notes.push('创建主页: 未配置主页模板（或类别无对应 Facebook 类别ID）'); continue; }
                            // Session 模式走接口创建、不需要浏览器；非 Session 模式要先启动浏览器（可带代理）
                            const firstProxy = Array.isArray(cfg.proxyPool) && cfg.proxyPool.length ? cfg.proxyPool[0] : null;
                            if (!pg.useSession) {
                                await ensureBrowser(firstProxy && firstProxy.proxy ? { proxyOverride: firstProxy.proxy } : {});
                                await sleep(3000);
                            }
                            const attempts = Array.isArray(cfg.proxyPool) && cfg.proxyPool.length ? cfg.proxyPool : [null];
                            let pageOk = false;
                            for (const pr of attempts) {
                                if (pageOk) break;
                                const body = { profileId: pid, name: pg.name, categoryId: pg.categoryId, bio: '', website: pg.website || '' };
                                if (pg.profileImageBase64) { body.profileImageBase64 = pg.profileImageBase64; body.profileImageName = pg.profileImageName || 'profile.jpg'; }
                                if (pg.coverImageBase64) { body.coverImageBase64 = pg.coverImageBase64; body.coverImageName = pg.coverImageName || 'cover.jpg'; }
                                if (pr && pr.proxy) body.proxyOverride = pr.proxy;
                                const j = await call('/api/facebook/page/create', body, signal).catch((e) => ({ success: false, message: e.message }));
                                if (j && j.success) {
                                    pageOk = true;
                                    notes.push(`主页创建 ✅ ID=${j.pageId}`);
                                } else {
                                    const why = (j && (j.message || (j.raw && (j.raw.error_user_title || j.raw.message)))) || '创建失败';
                                    notes.push(`主页创建 ❌ ${why}`);
                                    if (pr && pr.id) await markProxyFailed(pr.id);
                                    await sleep(30000);
                                }
                            }
                            if (!pageOk) notes.push('⛔ 所有代理尝试均失败');
                        } else if (sk === 'precheck') {
                            // 预检：账单页可访问 + 有卡片 + 有有效像素 + 主页模板已配置。
                            // 卡片/像素/主页模板都在前端缓存里，由 payload.precheck 下发，不在服务端另找数据源。
                            const pc = p.precheck || {};
                            if (!accIds.length) { notes.push('预检: 无广告号'); aborted = true; failed = true; continue; }
                            const allPassed = [];
                            for (const accId of accIds) {
                                let statusOk = false, label = '未知';
                                const j = await call('/api/facebook/billing/list-methods', { profileId: pid, adAccountId: accId }, signal).catch(() => null);
                                if (j && j.status === 'no_browser') label = '浏览器未运行';
                                else if (j && j.status === 'not_logged_in') label = '未登录';
                                else if (j && j.success) { statusOk = true; label = '正常(账单页可访问)'; }
                                else label = '账单页访问异常';
                                const hasCards = Number(pc.cardsCount || 0) > 0;
                                const pixelOk = !!pc.pixelOk;
                                const pageOk = pc.pageConfigured !== false;
                                const passed = statusOk && hasCards && pixelOk && pageOk;
                                allPassed.push(passed);
                                notes.push(`${accId} | 状态: ${label} | 卡片: ${Number(pc.cardsCount || 0)}张 | 像素: ${pixelOk ? `正常(${pc.pixelName || ''})` : '无'}${pageOk ? '' : ' | 主页: ❌未配置主页模板'}`);
                            }
                            if (allPassed.every(Boolean)) {
                                notes.push('✅ 预检全部通过');
                            } else {
                                aborted = true; failed = true;
                                notes.push('⛔ 预检未全部通过，跳过该配置的后续步骤');
                            }
                        } else if (sk === 'checkAd') {
                            if (!accIds.length) { notes.push('检查已有广告: 无广告号'); continue; }
                            let foundAd = false;
                            for (const accId of accIds) {
                                const j = await call('/api/facebook/publish-ad', { profileId: pid, adAccountId: accId, skipIfAdExists: true, onlyCheck: true }, signal).catch(() => null);
                                if (j && j.loginFailed) { foundAd = true; notes.push(`${accId}: ${j.message || '登录已过期'}`); }
                                else if (j && j.success && j.skipped) { foundAd = true; notes.push(`${accId}: 检查发现已有广告`); }
                                else notes.push(`${accId}: 未发现广告`);
                            }
                            // 已有广告 = 刻意跳过（不算失败）
                            if (foundAd) { aborted = true; notes.push('🛑 存在已有广告，跳过该配置的剩余步骤'); }
                        } else if (sk === 'publish') {
                            const pub = cfg.publish;
                            if (!pub || !pub.data) { notes.push('发布: 未配置广告内容（先在弹窗里配置好广告再执行）'); continue; }
                            if (!accIds.length) { notes.push('发布: 无广告号'); failed = true; continue; }
                            const pubAttempts = Array.isArray(pub.proxyPool) && pub.proxyPool.length ? pub.proxyPool : [null];
                            let pubOk = false;
                            for (const pr of pubAttempts) {
                                if (pubOk) break;
                                const body = {
                                    ...(pub.data || {}),
                                    publishMethod: pub.data.publishMethod || 'api',
                                    mediaFile: undefined,
                                    mediaBase64: pub.mediaBase64 || '',
                                    profileId: pid,
                                    adAccountId: accIds[0],
                                };
                                if (pr && pr.proxy) body.proxyOverride = pr.proxy;
                                if (body.publishMethod === 'puppeteer' || pub.data.launchBrowser) {
                                    await ensureBrowser(pr && pr.proxy ? { proxyOverride: pr.proxy } : {});
                                }
                                const j = await call('/api/facebook/publish-ad', body, signal).catch((e) => ({ success: false, message: e.message }));
                                // 「跳过」分两种：已有广告属预期（算成功）；Token 失效/无权重属真失败
                                const benignSkip = !!(j && j.skipped && j.skipReason === '已有广告');
                                if (j && j.success && (!j.skipped || benignSkip)) {
                                    pubOk = true;
                                    notes.push(benignSkip ? `发布跳过：${j.message || '已有广告'}` : `发布 ✅ ${j.message || '成功'}`);
                                } else {
                                    notes.push(`发布 ❌ ${(j && (j.message || j.error)) || '失败'}`);
                                    if (pr && pr.id) await markProxyFailed(pr.id);
                                    await sleep(30000);
                                }
                            }
                            if (!pubOk) { failed = true; notes.push('⛔ 发布失败'); }
                            await closeBrowser();
                        } else {
                            notes.push(`${sk}: 暂未接入队列（后续批次）`);
                        }
                    }
                } catch (e) {
                    notes.push(`执行异常: ${e && e.message ? e.message : e}`);
                    aborted = true; failed = true;
                } finally {
                    // 兜底：该配置处理完一定关掉我们启动的浏览器，别占着全局并发名额
                    await closeBrowser();
                }

                const detail = notes.join(' | ');
                return {
                    success: !failed,
                    message: `配置 ${pid}：${steps.length} 步${aborted ? '（提前中止）' : '已完成'}${detail ? ' · ' + detail : ''}`.slice(0, 1200),
                    raw: { profileId: pid, steps, notes, skipCard, proxyFailed },
                };
            },
        },
    };
}

class JobQueue {
    constructor({ dbPath, port, apiSecret, log, onConcurrencyChange }) {
        this.dbPath = dbPath;
        this.log = typeof log === 'function' ? log : () => {};
        // 失活探测要打本机 /api/browsers，这里把连接信息存下来
        this.port = port;
        this.apiSecret = apiSecret || '';
        // 🔗 并发数统一：队列自己的 concurrency 只决定「队列内同时跑几项」，
        //    真正卡住浏览器数量的是 browser-routes 里的全局闸门（LaunchQueue.maxConcurrent）。
        //    两个数字各说各话时，队列设 10、全局只有 5 → 一半任务卡在「等空位」，看起来像队列卡死。
        //    这里把队列并发同步给全局闸门，做到「改一个数字，两处同时生效」。
        this.onConcurrencyChange = typeof onConcurrencyChange === 'function' ? onConcurrencyChange : () => { };
        // 🗂️ 最近一次抓取的原始结果（profileId → {ts, payload}，LRU 上限 200）。
        //    队列只负责「把数据抓回来」，前端跑完后再取这份数据写回浏览器本地缓存
        //    （资产页读的是 localStorage 的 cache:adaccounts/pages/businesses/pixels/ads）。
        this._lastAssets = new Map();
        this.ops = buildOps(port, apiSecret, (pid, json) => {
            try {
                const key = String(pid);
                this._lastAssets.delete(key);
                this._lastAssets.set(key, { ts: Date.now(), payload: json });
                while (this._lastAssets.size > 200) {
                    const oldest = this._lastAssets.keys().next().value;
                    this._lastAssets.delete(oldest);
                }
            } catch { }
        }, (level, msg) => { try { this.log(level, msg); } catch { } });
        this.db = null;
        this.running = 0;
        this.concurrency = DEFAULT_CONCURRENCY;
        // 🎚️ 全局并发闸门：所有任务「正在执行的项」共享这一池坑位。
        //    以前 concurrency 只限制「同时跑几个任务」，任务内又各起 concurrency 个 worker，
        //    两层相乘 → 设 5 实际能同时跑 25 个浏览器操作。现在统一为：
        //    不管提交多少个任务，全局同时在跑的操作数最多 = this.concurrency。
        this.activeItems = 0;
        this._slotWaiters = [];
        // jobId -> { cancelRequested, aborts: Set<AbortController> }
        this.live = new Map();
        this._pumpScheduled = false;
    }

    // ---------- 基础设施 ----------

    async init() {
        await new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => (err ? reject(err) : resolve()));
        });
        await this._exec(`CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT,
            status TEXT NOT NULL,
            total INTEGER DEFAULT 0,
            done INTEGER DEFAULT 0,
            ok INTEGER DEFAULT 0,
            fail INTEGER DEFAULT 0,
            concurrency INTEGER,
            items TEXT,
            error TEXT,
            created_at INTEGER,
            started_at INTEGER,
            finished_at INTEGER
        )`);
        await this._exec(`CREATE TABLE IF NOT EXISTS job_settings (
            k TEXT PRIMARY KEY,
            v TEXT
        )`);
        // 🚀 大批量共享负载（例如「发布广告」的 campaignTree + 素材 base64）单独存一列：
        //    整批只存一份；而且进度更新时不重写它，否则每完成一个 item 都要往盘上写几十 MB。
        //    列已存在时 ALTER 会报错，直接忽略即可（老库升级路径）。
        try { await this._exec(`ALTER TABLE jobs ADD COLUMN shared TEXT`); } catch { }
        // 🔐 任务归属（本地按登录用户隔离）：老库补列，已存在会报错，忽略即可。
        //    历史任务该列为 NULL —— 视为「迁移前遗留」，仍在机器上可见（数量有限，清理即消失）。
        try { await this._exec(`ALTER TABLE jobs ADD COLUMN user_id TEXT`); } catch { }
        const saved = await this._get(`SELECT v FROM job_settings WHERE k = 'concurrency'`);
        const n = saved ? parseInt(saved.v, 10) : NaN;
        if (!isNaN(n)) this.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, n));
        // 🔗 启动时把（持久化的）并发数也应用到全局启动闸门，保证两处一致
        try { this.onConcurrencyChange(this.concurrency); } catch { }
        await this._resumeUnfinished();
        this.log('INFO', `🧵 [JobQueue] 已启动，并发=${this.concurrency}`);
        this._schedulePump();
    }

    _exec(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
        });
    }
    _get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
    }
    _all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
    }

    _row2job(row) {
        if (!row) return null;
        let items = [];
        try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
        return {
            id: row.id,
            type: row.type,
            title: row.title,
            status: row.status,
            total: row.total,
            done: row.done,
            ok: row.ok,
            fail: row.fail,
            concurrency: row.concurrency,
            error: row.error || '',
            createdAt: row.created_at,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            items: Array.isArray(items) ? items : [],
        };
    }

    async _save(job) {
        await this._exec(
            `UPDATE jobs SET status=?, total=?, done=?, ok=?, fail=?, items=?, error=?, started_at=?, finished_at=? WHERE id=?`,
            [job.status, job.total, job.done, job.ok, job.fail, JSON.stringify(job.items), job.error || '', job.startedAt || null, job.finishedAt || null, job.id],
        );
    }

    /** 后端重启后把上次没跑完的 job 恢复成 queued，只重跑没有结论的 item */
    async _resumeUnfinished() {
        const rows = await this._all(`SELECT ${JOB_COLS} FROM jobs WHERE status IN ('queued','running')`);
        for (const row of rows) {
            const job = this._row2job(row);
            if (!job) continue;
            job.items = job.items.map((it) => (it.status === 'done' || it.status === 'failed' || it.status === 'cancelled')
                ? it
                : { ...it, status: 'queued', message: '', startedAt: 0, finishedAt: 0 });
            job.total = job.items.length;
            job.done = job.items.filter((i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled').length;
            job.ok = job.items.filter((i) => i.status === 'done').length;
            job.fail = job.items.filter((i) => i.status === 'failed').length;
            job.status = 'queued';
            job.startedAt = null;
            job.finishedAt = null;
            await this._save(job);
        }
        if (rows.length) this.log('WARN', `🧵 [JobQueue] 恢复 ${rows.length} 个未完成任务，继续执行`);
    }

    // ---------- 对外 API ----------

    async submit({ type, title, items, concurrency, shared, userId }) {
        if (!this.ops[type]) throw new Error(`不支持的任务类型: ${type}`);
        if (!Array.isArray(items) || items.length === 0) throw new Error('任务内容为空');
        // 🚀 共享负载整批只存一份（例如发布广告的 campaignTree+素材），并限制体量
        let sharedJson = '';
        if (shared && typeof shared === 'object') {
            sharedJson = JSON.stringify(shared);
            const mb = sharedJson.length / 1048576;
            if (mb > 30) throw new Error(`任务公共数据过大（${mb.toFixed(1)}MB），请减少素材数量或压缩后再试`);
        }
        const id = `job_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            id,
            type,
            title: title || this.ops[type].label,
            status: 'queued',
            total: items.length,
            done: 0,
            ok: 0,
            fail: 0,
            // 🎚️ 并发不再按任务单独设置：所有任务共享全局闸门 this.concurrency，
            //    这里只记录一个快照值供界面展示（调用方传的 concurrency 一律忽略）。
            concurrency: this.concurrency,
            error: '',
            createdAt: nowMs(),
            startedAt: null,
            finishedAt: null,
            items: items.map((it, idx) => ({
                key: String(it.key != null ? it.key : idx),
                label: String(it.label || it.payload?.profileId || it.key || ''),
                // 🧩 支持单 job 内混合类型项（如「创建BM」job 末尾追加一个 get_info 项）：
                //    未显式指定 type 的项沿用 job.type（向后兼容老任务）
                type: String(it.type || '').trim() || undefined,
                status: 'queued',
                message: '',
                startedAt: 0,
                finishedAt: 0,
                payload: it.payload || {},
            })),
        };
        await this._exec(
            `INSERT INTO jobs (id, type, title, status, total, done, ok, fail, concurrency, items, error, created_at, started_at, finished_at, shared, user_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [job.id, job.type, job.title, job.status, job.total, 0, 0, 0, job.concurrency, JSON.stringify(job.items), '', job.createdAt, null, null, sharedJson || null, String(userId || '') || null],
        );
        this.log('INFO', `🧵 [JobQueue] 新任务 ${job.id} ${job.type}（${job.total} 项）：${job.title}`);
        this._schedulePump();
        return job;
    }

    /**
     * 🔐 用户隔离条件：调用方带 user_id 时，只看「自己的 + 迁移前遗留(NULL)的」。
     *    不带 user_id（内部调用/本机脚本）时维持原行为，不做过滤。
     */
    _ownerClause(userId) {
        const uid = String(userId || '');
        if (!uid) return { sql: '', params: [] };
        return { sql: ` AND (user_id IS NULL OR user_id = '' OR user_id = ?)`, params: [uid] };
    }

    async list(limit = 50, userId = '') {
        const own = this._ownerClause(userId);
        const rows = await this._all(
            `SELECT ${JOB_COLS} FROM jobs WHERE 1=1${own.sql} ORDER BY created_at DESC LIMIT ?`,
            [...own.params, Math.max(1, Math.min(200, limit))],
        );
        const jobs = rows.map((r) => this._row2job(r)).filter(Boolean);
        const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
        for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
        return { jobs, counts, concurrency: this.concurrency };
    }

    async get(id, userId = '') {
        const own = this._ownerClause(userId);
        return this._row2job(await this._get(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?${own.sql}`, [id, ...own.params]));
    }

    /** 单独取大批量共享负载（只有执行任务时才需要，避免列表接口被几十 MB 拖垮） */
    async _loadShared(id) {
        const row = await this._get(`SELECT shared FROM jobs WHERE id = ?`, [id]);
        if (!row || !row.shared) return null;
        try { return JSON.parse(row.shared); } catch { return null; }
    }

    /** 取消：queued 直接标记；running 置标记并 abort 在飞请求，当前 item 结束后停下 */
    async cancel(id, userId = '') {
        const job = await this.get(id, userId);
        if (!job) return { success: false, message: '任务不存在' };
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
            return { success: false, message: '任务已结束' };
        }
        const live = this.live.get(id);
        if (live) {
            live.cancelRequested = true;
            // 🔌 逐个 abort：同一 job 并发跑多项时，以前的单个 live.abort 会被后者覆盖，
            //    结果只能打断最后一项
            for (const c of live.aborts) { try { c.abort(); } catch { } }
        } else {
            // 还没开跑：整单标记取消
            job.status = 'cancelled';
            job.finishedAt = nowMs();
            job.items = job.items.map((it) => it.status === 'queued' ? { ...it, status: 'cancelled', finishedAt: nowMs() } : it);
            job.done = job.items.filter((i) => i.status !== 'queued' && i.status !== 'running').length;
            await this._save(job);
        }
        if (live) {
            job.items = job.items.map((it) => it.status === 'queued' ? { ...it, status: 'cancelled', finishedAt: nowMs() } : it);
            job.status = 'cancelled';
            job.finishedAt = nowMs();
            await this._save(job);
        }
        this.log('WARN', `🧵 [JobQueue] 任务 ${id} 已请求取消`);
        return { success: true };
    }

    async cancelAll(userId = '') {
        const own = this._ownerClause(userId);
        const rows = await this._all(`SELECT id FROM jobs WHERE status IN ('queued','running')${own.sql}`, own.params);
        for (const r of rows) await this.cancel(r.id, userId).catch(() => { });
        return { success: true, cancelled: rows.length };
    }

    async clearFinished(userId = '') {
        const own = this._ownerClause(userId);
        await this._exec(`DELETE FROM jobs WHERE status IN ('done','failed','cancelled')${own.sql}`, own.params);
        return { success: true };
    }

    async setConcurrency(n) {
        const v = Math.max(1, Math.min(MAX_CONCURRENCY, parseInt(n, 10) || DEFAULT_CONCURRENCY));
        this.concurrency = v;
        await this._exec(`INSERT OR REPLACE INTO job_settings (k, v) VALUES ('concurrency', ?)`, [String(v)]);
        // 🔗 同步到全局启动闸门（两者是同一个数字）
        try { this.onConcurrencyChange(v); } catch { }
        // 调大后立刻放行排队中的项（_releaseSlot 只在有项结束时唤醒，这里补唤醒一次）
        this._wakeWaiters();
        this.log('INFO', `🧵 [JobQueue] 全局并发数已更新: ${v}（同时在跑的操作数上限）`);
        this._schedulePump();
        return v;
    }

    // ---------- 全局并发闸门 ----------

    /**
     * 领取一个全局执行坑位，返回「归还函数」（幂等，重复调用安全）。
     * 坑位满了就在队列里等，等有项结束（或并发数被调大）时被唤醒；
     * 被唤醒即视为已经拿到坑位，计数不再自增。
     */
    _acquireSlot() {
        let done = false;
        const release = () => {
            if (done) return;
            done = true;
            const next = this._slotWaiters.shift();
            if (next) { next(); return; }             // 坑位直接转交给排队者，计数不变
            this.activeItems = Math.max(0, this.activeItems - 1);
        };
        if (this.activeItems < this.concurrency) {
            this.activeItems++;
            return Promise.resolve(release);
        }
        return new Promise((resolve) => { this._slotWaiters.push(() => resolve(release)); });
    }

    /** 并发数调大后补唤醒排队者，直到坑位填满 */
    _wakeWaiters() {
        while (this._slotWaiters.length && this.activeItems < this.concurrency) {
            const next = this._slotWaiters.shift();
            this.activeItems++;
            next();
        }
    }

    // ---------- 调度 ----------

    _schedulePump() {
        if (this._pumpScheduled) return;
        this._pumpScheduled = true;
        setTimeout(() => { this._pumpScheduled = false; this._pump().catch(() => { }); }, 50);
    }

    async _pump() {
        if (this.running >= this.concurrency) return;
        const rows = await this._all(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`, [this.concurrency - this.running]);
        for (const row of rows) {
            const job = this._row2job(row);
            if (!job) continue;
            if (this.running >= this.concurrency) break;
            this._runJob(job).catch((e) => this.log('ERROR', `🧵 [JobQueue] 任务 ${job.id} 异常: ${e && e.message}`));
        }
    }

    /**
     * 🔎 浏览器失活探测：手动关掉浏览器 / 浏览器崩溃后，本机那条接口会一直挂着不返回。
     *    这里每 5s 查一次 /api/browsers，发现「该项的浏览器曾经活着、现在没了」就立刻 abort，
     *    几秒内判失败，而不是干等 socket 空闲超时（回环 280s）。
     *    ⚠️ 只认「先出现过、后消失」：启动阶段浏览器本来就还没出现，不能误判成失活。
     *    返回一个停止函数。
     */
    _watchBrowserGone(item, ctrl, state) {
        const pid = String((item.payload && item.payload.profileId) || '');
        if (!pid) return () => { };
        const probeUrl = `http://127.0.0.1:${this.port}/api/browsers`;
        let seenAlive = false;
        // 🐛 防误杀复核窗口：launch 流程「清理残留实例 → 启动新实例」有几秒空窗（实测 3~4s），
        //    此刻 /api/browsers 里旧实例已删、新实例还没注册 → 以前「发现消失立即 abort」会把
        //    正在正常启动的任务项误杀（日志「配置 X 的浏览器已关闭，中止当前任务项」有一部分就是它），
        //    且新启动的浏览器随之无人认领（borrowLaunch 已被打断，startedByUs=false）→ 永久保留不关闭。
        //    现在消失后先进入复核窗口（10s，覆盖 2 个探测周期），窗口内浏览器重新出现（新实例接管）
        //    则视作正常重启不中止；复核后仍消失才判定真失活。真崩溃的失败判定从 ~5s 变 ~10-15s，可接受。
        let goneSince = 0;
        const GONE_CONFIRM_MS = 10000;
        let stopped = false;
        let probing = false;
        const tick = async () => {
            if (stopped || probing || ctrl.signal.aborted) return;
            probing = true;
            try {
                const resp = await fetch(probeUrl, { headers: { 'X-Api-Secret': this.apiSecret } });
                const json = await resp.json();
                const list = Array.isArray(json && json.data) ? json.data : [];
                if (list.some((b) => String(b && b.profileId) === pid)) {
                    seenAlive = true;
                    goneSince = 0; // 浏览器（重新）出现，清掉复核计时
                    return;
                }
                if (seenAlive) {
                    // 🎯 排队/启动保护：本任务项还没真正拿到浏览器（borrowLaunch 未成功标记
                    //    signal.__browserReady）时，「浏览器消失」只是别人的实例在正常关闭/重启，
                    //    与本任务无关 → 不中止，避免排队等闸门的任务被误杀。
                    if (!ctrl.signal.__browserReady) return;
                    if (!goneSince) {
                        goneSince = Date.now();
                        this.log('INFO', `🧵 [JobQueue] 配置 ${pid} 的浏览器暂不可见，${GONE_CONFIRM_MS}ms 后复核（可能在重启空窗期）`);
                        return;
                    }
                    if (Date.now() - goneSince < GONE_CONFIRM_MS) return; // 复核窗口内，再等一轮
                    state.reason = 'browser-gone';
                    this.log('WARN', `🧵 [JobQueue] 配置 ${pid} 的浏览器已关闭（复核确认），中止当前任务项`);
                    try { ctrl.abort(); } catch { }
                }
            } catch { /* 探测本身失败不影响主流程，交给原有超时兜底 */ }
            finally { probing = false; }
        };
        const timer = setInterval(tick, PROBE_INTERVAL_MS);
        return () => { stopped = true; clearInterval(timer); };
    }

    // 🔁 跨 job 查「同号是否还有待执行项」：扫 queued/running job 的 items（SQLite，量小）。
    //    供创建类任务的浏览器保留决策用（创建BM → 联动的获取信息 job 直接管住浏览器复用）。
    async _hasPendingItemForProfile(pid) {
        try {
            const rows = await this._all(`SELECT items FROM jobs WHERE status IN ('queued','running')`);
            for (const row of rows) {
                let items = [];
                try { items = JSON.parse(row.items || '[]'); } catch { continue; }
                if (Array.isArray(items) && items.some((it) => it && it.status === 'queued'
                    && String((it.payload && it.payload.profileId) || '') === String(pid))) return true;
            }
        } catch {}
        return false;
    }

    async _runJob(job) {
        this.running++;
        const live = { cancelRequested: false, aborts: new Set(), slots: new Set() };
        this.live.set(job.id, live);
        // ⚠️ 整个函数体都在 try 里：以前 this.running++ 之后那句 _save 在 try 之外，
        //    一旦它抛异常（SQLite BUSY 等）finally 就不会执行 → 并发槽永久泄漏，
        //    泄漏满 concurrency 个之后 _pump() 永远提前返回，队列彻底不动。
        try {
            job.status = 'running';
            job.startedAt = nowMs();
            await this._save(job);
            this.log('INFO', `🧵 [JobQueue] 开始执行 ${job.id} ${job.type}（${job.total} 项，全局并发 ${this.concurrency}）`);

            // 🚀 只有真正执行时才把大批量共享负载读出来（列表接口不带它）
            const shared = await this._loadShared(job.id).catch(() => null);

            const pending = job.items.filter((it) => it.status === 'queued');
            // 🎚️ worker 数固定按全局上限起（真正同时跑几项由全局闸门决定，多出来的 worker 排在闸门前）。
            //    不能按「当前并发数」起 worker：那样任务开始后把并发调大也不会生效（没有多余的 worker 可唤醒）。
            const limit = Math.max(1, Math.min(MAX_CONCURRENCY, pending.length || 1));

            // 📊 单项一完成就落库：以前只在整批 Promise.all 之后才存，
            //    并发跑的时候界面上会看到整批都停在"进行中"，即使其中某个早就做完了。
            //    加 500ms 节流避免并发多时写得过频；被节流跳过的那些由批末的统一保存兜住。
            let lastProgressSaveTs = 0;
            const saveItemProgress = async (force) => {
                job.done = job.items.filter((it) => it.status === 'done' || it.status === 'failed' || it.status === 'cancelled').length;
                job.ok = job.items.filter((it) => it.status === 'done').length;
                job.fail = job.items.filter((it) => it.status === 'failed').length;
                const now = nowMs();
                if (!force && now - lastProgressSaveTs < 500) return;
                lastProgressSaveTs = now;
                await this._save(job).catch(() => { });
            };

            // 🔄 滚动补位：谁先做完就立刻领下一项，不再「等整批」。
            //    以前是 for + Promise.all(一批)：批里最慢的一项会把已经空出来的槽位一直拖住
            //    （实测一批里 4340 只用 44s 就完成了，整批却要等到 162s）。
            //    ⚠️ 已从 cursor 自增改为可变队列（queue.shift）：下面要做「同号串行」，
            //       需要把暂时不能跑的项挪回队尾重排，而 cursor 一旦越过该项就再也取不到了。
            // 🚶 行为节奏：同一个号串行 + 每次操作前的随机停顿。
            // ⚠️ 默认已关闭（0）—— 启动/取数要抢时间，前端点完就希望浏览器立刻拉起来。
            //    这个停顿当初是为了削弱「机器快速产生大量动态操作」的特征，属于反检测手段；
            //    需要重新启用时设 ACTION_JITTER_MIN_MS / ACTION_JITTER_MAX_MS（例如 2000/6000）再重启。
            const jitterMin = Number(process.env.ACTION_JITTER_MIN_MS ?? 0);
            const jitterMax = Number(process.env.ACTION_JITTER_MAX_MS ?? 0);
            const canJitter = Number.isFinite(jitterMin) && Number.isFinite(jitterMax) && jitterMax > 0;
            // 🚦 正在执行的 profileId（实例级，跨任务共享）：同一个号的浏览器操作必须串行
            const busyProfiles = this._busyProfiles || (this._busyProfiles = new Set());
            const queue = pending.slice();
            // 🔁 「同号还有后续任务」的判定升级为**跨 job**：创建类任务完成后如果紧接着
            //    有一个「获取信息」job（创建BM联动自动追加）含同号项，浏览器保留给它复用，
            //    不做一次无谓的归还+冷启动。本 job 队列先查（同步、零开销），查不到再查
            //    其他 queued/running job（SQLite，量小）。
            const hasNextForProfile = async (qpid) => {
                const s = String(qpid);
                if (queue.some((it) => String((it.payload && it.payload.profileId) || '') === s)) return true;
                return await this._hasPendingItemForProfile(s);
            };
            const runWorker = async () => {
                while (true) {
                    if (live.cancelRequested) return;
                    const item = queue.shift();
                    if (!item) return;
                    const pid = String((item.payload && item.payload.profileId) || '');
                    // 同号串行：该号正在被别的 worker 执行 → 挪到队尾，让其它号的任务先跑
                    if (pid && busyProfiles.has(pid)) {
                        queue.push(item);
                        await sleep(500);
                        continue;
                    }
                    if (pid) busyProfiles.add(pid);

                    // 🎚️ 先抢全局坑位才真正开工：抢到之前该项仍算「排队中」，不占用浏览器
                    const releaseSlot = await this._acquireSlot();
                    live.slots.add(releaseSlot);
                    try {
                        if (live.cancelRequested) { item.status = 'cancelled'; item.finishedAt = nowMs(); return; }

                        item.status = 'running';
                        item.startedAt = nowMs();
                        await this._save(job);
                        // 🚶 随机停顿放在建计时器之前：不占用该项的超时预算
                        if (canJitter) {
                            const wait = jitterMin + Math.floor(Math.random() * Math.max(1, jitterMax - jitterMin));
                            this.log('INFO', `🚶 [JobQueue] ${item.key || pid} 操作前随机停顿 ${(wait / 1000).toFixed(1)}s`);
                            await sleep(wait);
                        }
                        if (live.cancelRequested) { item.status = 'cancelled'; item.finishedAt = nowMs(); return; }
                        const ctrl = new AbortController();
                        // 记录被中止的原因，用来区分「超时」和「浏览器被关了」
                        const state = { reason: '' };
                        live.aborts.add(ctrl);
                        const timer = setTimeout(() => { state.reason = 'timeout'; ctrl.abort(); }, ITEM_TIMEOUT_MS);
                        // 「关闭浏览器」这类 op 的语义就是浏览器消失，不能反过来判定它失活
                        const stopWatch = job.type === 'stop_browser' ? () => { } : this._watchBrowserGone(item, ctrl, state);
                        // 🔁 hasNextForProfile 用外层的跨 job 版（本 job queue + 其他 queued/running job）。
                        //    🐛 以前这里有一个同 job 局部版把它遮蔽了 → 「创建BM联动自动获取信息」
                        //    分属两个 job，创建项完成时查不到另一个 job 里的同号项 → 浏览器被归还关闭，
                        //    获取信息每次都冷启动（跨 job 浏览器保留从未生效过）。
                        try {
                            // 🧩 项级类型优先：单 job 内允许混合类型项（创建BM job 末尾追加的 get_info 项）；
                            //    未带 type 的项沿用 job.type，所有存量任务行为不变。
                            //    ⚠️ op 必须逐项取——以前取在 _runJob 顶层，整个 job 的所有项复用同一个 op。
                            const itemOp = this.ops[item.type || job.type];
                            if (!itemOp) throw new Error(`未注册的任务类型: ${item.type || job.type}`);
                            const r = await itemOp.run(item, { signal: ctrl.signal, shared, job, hasNextForProfile });
                            item.status = r.success ? 'done' : 'failed';
                            // 组合任务（智能发布）的明细都在 message 里，留长一点，否则队列页只能看到开头
                            item.message = String(r.message || '').slice(0, 2000);
                        } catch (e) {
                            const aborted = ctrl.signal.aborted;
                            item.status = live.cancelRequested ? 'cancelled' : 'failed';
                            if (aborted && !live.cancelRequested) {
                                item.message = state.reason === 'browser-gone'
                                    ? '浏览器已被关闭，任务中止'
                                    : `超时(${Math.round(ITEM_TIMEOUT_MS / 1000)}s)`;
                            } else {
                                item.message = String((e && e.message) || e).slice(0, 2000);
                            }
                        } finally {
                            clearTimeout(timer);
                            stopWatch();
                            live.aborts.delete(ctrl);
                            item.finishedAt = nowMs();
                            // 这一项有结论了 → 立刻让前端能看到，并马上回循环领下一项
                            await saveItemProgress();
                        }
                    } finally {
                        // 🎚️ 成功/失败/取消/抛异常都必须归还坑位，否则并发池会被慢慢抽干
                        live.slots.delete(releaseSlot);
                        releaseSlot();
                        // 🚦 释放该号的占用，后面的同号任务才能继续跑
                        if (pid) busyProfiles.delete(pid);
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(limit, pending.length) }, () => runWorker())
            );
            await saveItemProgress(true);

            if (live.cancelRequested) {
                job.items = job.items.map((it) => it.status === 'queued' ? { ...it, status: 'cancelled', finishedAt: nowMs() } : it);
                job.status = 'cancelled';
            } else {
                job.status = job.fail > 0 ? 'failed' : 'done';
            }
        } catch (e) {
            job.status = 'failed';
            job.error = String((e && e.message) || e).slice(0, 400);
        } finally {
            job.done = job.items.filter((it) => it.status === 'done' || it.status === 'failed' || it.status === 'cancelled').length;
            job.ok = job.items.filter((it) => it.status === 'done').length;
            job.fail = job.items.filter((it) => it.status === 'failed').length;
            job.finishedAt = nowMs();
            await this._save(job).catch(() => { });
            // 🚀 任务结束后释放共享大负载，别让几十 MB 的广告素材长期占着数据库
            if (job.status !== 'queued' && job.status !== 'running') {
                await this._exec(`UPDATE jobs SET shared = NULL WHERE id = ?`, [job.id]).catch(() => { });
            }
            // 🎚️ 兜底：任何异常路径遗留的坑位在这里统一归还（release 幂等，重复调用无害）
            for (const releaseSlot of live.slots) { try { releaseSlot(); } catch { } }
            live.slots.clear();
            this.live.delete(job.id);
            this.running = Math.max(0, this.running - 1);
            this.log('INFO', `🧵 [JobQueue] 任务结束 ${job.id}：${job.status}（成功 ${job.ok}/${job.total}）`);
            this._schedulePump();
        }
    }

    /** HTTP 路由注册 */
    registerRoutes(app) {
        /**
         * 🔐 从 `Authorization: Bearer base64(id:email:role)` 解出当前登录用户 id。
         *    注意：队列服务跑在本机（单机执行代理），这里只做「界面归属过滤」，
         *    目的是防止同机切号时 A 看到/取消 B 的任务，不构成对抗性安全边界。
         *    解不出来（内部调用、脚本）时返回 ''，按原行为不过滤。
         */
        const userIdOf = (req) => {
            try {
                const h = String((req.headers && req.headers.authorization) || '');
                if (!h) return '';
                const token = h.startsWith('Bearer ') ? h.slice(7) : h;
                const parts = Buffer.from(token, 'base64').toString('utf8').split(':');
                return String(parts[0] || '');
            } catch { return ''; }
        };

        const wrap = (fn) => async (req, res) => {
            try { res.json({ success: true, ...(await fn(req)) }); }
            catch (e) { res.status(500).json({ success: false, message: String((e && e.message) || e) }); }
        };

        app.get('/api/jobs', wrap(async (req) => {
            const limit = parseInt(req.query.limit, 10) || 50;
            return await this.list(limit, userIdOf(req));
        }));

        app.post('/api/jobs', wrap(async (req) => {
            const { type, title, items, concurrency, shared } = req.body || {};
            const job = await this.submit({ type, title, items, concurrency, shared, userId: userIdOf(req) });
            return { job };
        }));

        app.post('/api/jobs/cancel-all', wrap(async (req) => await this.cancelAll(userIdOf(req))));

        app.post('/api/jobs/clear-finished', wrap(async (req) => await this.clearFinished(userIdOf(req))));

        app.post('/api/jobs/settings', wrap(async (req) => {
            const v = await this.setConcurrency((req.body || {}).concurrency);
            return { concurrency: v };
        }));

        app.post('/api/jobs/:id/cancel', wrap(async (req) => await this.cancel(req.params.id, userIdOf(req))));

        // 🗂️ 取「最近一次抓取的原始结果」：前端在队列跑完后用它写回本地缓存
        // ⚠️ 必须注册在 /api/jobs/:id 之前，否则会被 :id 抢先匹配（id='last-assets'）
        app.get('/api/jobs/last-assets', wrap(async (req) => {
            const pid = String(req.query.profileId || '');
            const hit = pid ? this._lastAssets.get(pid) : null;
            if (!hit) return { found: false, data: null };
            return { found: true, ts: hit.ts, data: hit.payload };
        }));

        app.get('/api/jobs/:id', wrap(async (req) => {
            const job = await this.get(req.params.id, userIdOf(req));
            if (!job) throw new Error('任务不存在');
            return { job };
        }));
    }
}

module.exports = { JobQueue, DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
