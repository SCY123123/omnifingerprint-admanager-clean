/**
 * 广告数据追踪 + 账单信息路由模块
 *
 * 复用 facebook-graph.js 的 callFacebookGraphApi（浏览器上下文调 Graph API，不走直连 ——
 * 直连 Graph 会超时，见项目经验）。抓到的结果：
 *   1) 返回给队列（前端进度/消息用）
 *   2) 由本模块直接用 X-Api-Secret 同步云端（归属按 profile_id → profiles.user_id 映射，与
 *      adaccounts/bulk-save 同一套机制），前端拿到任务完成通知后直接读云端列表即可。
 *
 * 注册：puppeteer-api-server.js 里 __inject + registerRoutes（与 billing-routes 同款）。
 */

let _deps = {};
function __inject(deps) {
    _deps = deps || {};
}

function registerRoutes() {
    const { log, app, callFacebookGraphApi, findProfileById, API_SECRET } = _deps;
    if (!app) throw new Error('[facebook-insights-routes] missing app');

    // ---------- 公共工具 ----------

    /** 归一化广告号 ID 列表：去 act_ 前缀、去重、只留纯数字 */
    function normalizeActIds(input) {
        return [...new Set((Array.isArray(input) ? input : [])
            .map((x) => String(x || '').trim().replace(/^act_/i, ''))
            .filter((x) => /^\d+$/.test(x)))];
    }

    // 💰 Meta Graph 金额字段是「货币最小单位」（USD 即分）→ 入库前统一换算成主单位。
    //    必须和 facebook-billing-routes 的 FetchAdAccounts 保持同一口径（写「元」），
    //    否则「账单查询(billing-info)」会把分写进 ad_accounts，列表里的花费/账单/门槛就会多两个 0。
    const ZERO_DECIMAL_CURRENCIES = new Set([
        'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV',
        'XAF', 'XOF', 'XPF', 'GNF', 'KMF', 'DJF', 'BIF',
    ]);
    function toMajorAmount(amount, currency) {
        const n = Number(amount);
        if (!Number.isFinite(n)) return 0;
        const div = ZERO_DECIMAL_CURRENCIES.has(String(currency || '').trim().toUpperCase()) ? 1 : 100;
        return Math.round((n / div) * 100) / 100;
    }

    /** 从 actions 数组里挑「转化」数：购买类 > 线索类 > 站外转化 > 落地页浏览 */
    function pickResultValue(actions) {
        if (!Array.isArray(actions) || actions.length === 0) return 0;
        const find = (re) => actions.find((a) => re.test(String(a.action_type || '')));
        const hit = find(/purchase/i) || find(/lead/i) || find(/^offsite_conversion/) || find(/landing_page_view/i);
        return hit ? (Number(hit.value) || 0) : 0;
    }

    /** 本地 → 云端同步（X-Api-Secret；归属由 profile_id 在云端映射） */
    async function syncToCloud(path, items) {
        const storageBase = String(process.env.STORAGE_SERVER_URL || '').replace(/\/$/, '');
        try {
            const resp = await fetch(`${storageBase}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                body: JSON.stringify({ items }),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                log('WARN', `[insights-sync] ${path} -> HTTP ${resp.status} ${text.slice(0, 200)}`);
                return false;
            }
            return true;
        } catch (e) {
            log('WARN', `[insights-sync] ${path} 同步失败: ${e.message}`);
            return false;
        }
    }

    // ---------- 数据追踪：广告层级 insights ----------
    // POST /api/facebook/adaccounts/insights
    // body: { profileId, adAccountIds: [], datePreset: 'last_7d', accessToken? }
    app.post('/api/facebook/adaccounts/insights', async (req, res) => {
        try {
            const { profileId, datePreset = 'last_7d', accessToken } = req.body || {};
            if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
            const acts = normalizeActIds(req.body.adAccountIds);
            if (!acts.length) return res.status(400).json({ success: false, message: '没有指定广告号' });

            const preset = String(datePreset).replace(/[^a-z0-9_]/gi, '') || 'last_7d';
            const profile = await findProfileById(profileId);
            const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
            if (!effectiveToken) return res.status(400).json({ success: false, message: '缺少 Access Token' });

            const FIELDS = 'ad_id,ad_name,adset_name,campaign_name,impressions,clicks,ctr,cpc,cpm,spend,actions';
            const allRows = [];
            const errors = [];

            for (const act of acts) {
                let after = '';
                let pages = 0;
                try {
                    // 翻页最多 4 次（300×4=1200 条广告/账户，足够）
                    do {
                        const q = `act_${act}/insights?level=ad&fields=${FIELDS}&date_preset=${preset}&limit=300${after ? `&after=${encodeURIComponent(after)}` : ''}`;
                        const json = await callFacebookGraphApi(q, 'GET', null, profile, effectiveToken);
                        if (json && json.error) {
                            errors.push(`act_${act}: ${json.error.message || 'Graph 错误'}`);
                            break;
                        }
                        const data = Array.isArray(json && json.data) ? json.data : [];
                        for (const r of data) {
                            allRows.push({
                                profile_id: String(profileId),
                                account_id: act,
                                ad_id: String(r.ad_id || ''),
                                ad_name: String(r.ad_name || ''),
                                adset_name: String(r.adset_name || ''),
                                campaign_name: String(r.campaign_name || ''),
                                date_start: String(r.date_start || ''),
                                date_stop: String(r.date_stop || ''),
                                date_preset: preset,
                                impressions: Number(r.impressions || 0),
                                clicks: Number(r.clicks || 0),
                                ctr: Number(r.ctr || 0),
                                cpc: Number(r.cpc || 0),
                                cpm: Number(r.cpm || 0),
                                spend: Number(r.spend || 0),
                                results: pickResultValue(r.actions),
                                actions_json: Array.isArray(r.actions) ? JSON.stringify(r.actions) : '',
                            });
                        }
                        after = (json && json.paging && json.paging.cursors && json.paging.cursors.after) || '';
                        pages++;
                    } while (after && pages < 4);
                } catch (e) {
                    errors.push(`act_${act}: ${e.message || e}`);
                }
            }

            // 同步云端（不等它成功——失败只记日志，数据仍然返回给队列）
            let synced = false;
            if (allRows.length) synced = await syncToCloud('/api/insights/bulk-save', allRows);

            log('INFO', `[insights] 配置 ${profileId} preset=${preset} 广告号 ${acts.length} 个 -> 数据 ${allRows.length} 条 (sync=${synced})`);
            return res.json({
                success: true,
                total: allRows.length,
                accounts: acts.length,
                synced,
                errors,
                rows: allRows,
            });
        } catch (e) {
            log('ERROR', `[insights] 失败: ${e.message}`);
            return res.status(500).json({ success: false, message: e.message || String(e) });
        }
    });

    // ---------- 账单查询：广告号级别花费/余额/支付方式 ----------
    // POST /api/facebook/adaccounts/billing-info
    // body: { profileId, adAccountIds: [], accessToken? }
    app.post('/api/facebook/adaccounts/billing-info', async (req, res) => {
        try {
            const { profileId, accessToken } = req.body || {};
            if (!profileId) return res.status(400).json({ success: false, message: 'missing profileId' });
            const acts = normalizeActIds(req.body.adAccountIds);
            if (!acts.length) return res.status(400).json({ success: false, message: '没有指定广告号' });

            const profile = await findProfileById(profileId);
            const effectiveToken = accessToken || profile?.account_tokens || profile?.token || '';
            if (!effectiveToken) return res.status(400).json({ success: false, message: '缺少 Access Token' });

            // ⚠️ 不要加 funding_source_details：该字段需要额外权限，未授权时不是被忽略，
            //    而是让**整个请求**报 "Invalid request."（实测 v21.0）。funding_source 已够用。
            const FIELDS = 'name,account_status,currency,amount_spent,spend_cap,balance,funding_source,business_country_code,timezone_id';
            const items = [];
            const errors = [];

            for (const act of acts) {
                try {
                    const json = await callFacebookGraphApi(`act_${act}?fields=${FIELDS}`, 'GET', null, profile, effectiveToken);
                    if (json && json.error) {
                        errors.push(`act_${act}: ${json.error.message || 'Graph 错误'}`);
                        continue;
                    }
                    if (!json || !json.account_id && !json.name) {
                        errors.push(`act_${act}: 空响应`);
                        continue;
                    }
                    const fd = json.funding_source_details || {};
                    const fundingDisplay = fd && fd.type
                        ? `${String(fd.type)}${fd.last4 ? ` ****${fd.last4}` : ''}`
                        : String(json.funding_source || '');
                    items.push({
                        id: `act_${act}`,
                        account_id: act,
                        name: String(json.name || ''),
                        account_status: Number(json.account_status && json.account_status.id !== undefined ? json.account_status.id : (json.account_status || 0)),
                        currency: String(json.currency || ''),
                        amount_spent: toMajorAmount(json.amount_spent, json.currency),  // → 云端 spend（元）
                        spend_cap: toMajorAmount(json.spend_cap, json.currency),        // → 云端 threshold_amount（元，0=未设上限）
                        // 🚀 credit_limit（列表「额度」列）沿用 Meta 原值（分）——与「获取信息」写入口径一致，
                        //    否则本任务没带这个字段会被 bulk-save 写成 0，把额度清空。
                        creditLimit: Number(json.spend_cap || 0),
                        balance: toMajorAmount(json.balance, json.currency),
                        funding_source: fundingDisplay,                    // → 云端 funding_source
                        business_country_code: String(json.business_country_code || ''),
                        timezone_id: String(json.timezone_id || ''),
                        profile_id: String(profileId),
                    });
                } catch (e) {
                    errors.push(`act_${act}: ${e.message || e}`);
                }
            }

            let synced = false;
            if (items.length) synced = await syncToCloud('/api/adaccounts/bulk-save', items);

            log('INFO', `[billing-info] 配置 ${profileId} 广告号 ${acts.length} 个 -> 成功 ${items.length} 条 (sync=${synced})`);
            return res.json({ success: true, total: items.length, synced, errors, items });
        } catch (e) {
            log('ERROR', `[billing-info] 失败: ${e.message}`);
            return res.status(500).json({ success: false, message: e.message || String(e) });
        }
    });
}

module.exports = { __inject, registerRoutes };
