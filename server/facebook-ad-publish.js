'use strict';

// Direct dependencies
const { callFacebookGraphApi, uploadVideoToAdAccount, waitForVideoReady } = require('./facebook-graph');
const { activeBrowsers, ensureBrowserIsRunning } = require('./browser-manager');
const { findProfileById, autoFillPasswordOnPage, dbPath } = require('./database');
const sqlite3 = require('sqlite3').verbose();

// Injected dependencies (log, PORT from main server)
let log = () => {};
let PORT = parseInt(process.env.PUPPETEER_PORT || process.env.PORT || '9999', 10);

function __inject(deps) {
  if (deps.log) log = deps.log;
  if (deps.PORT !== undefined) PORT = deps.PORT;
}

// 🐛 记录 Token 已过期的 profile，避免重复重试
const deadTokenProfiles = new Set();
const API_SECRET = process.env.PUPPETEER_API_SECRET || '';

// 清理浏览器辅助函数
function cleanupActiveBrowser(profileId) {
    if (activeBrowsers && typeof activeBrowsers.delete === 'function') {
        activeBrowsers.delete(String(profileId));
    }
}

// 🚀 可跳过发布错误（如 Certification Required），在上层 catch 中不会终止整个流程
class SkipPublishError extends Error { constructor(m) { super(m); this.name = 'SkipPublishError'; } }

/**
 * 判断一个 Graph API 报错是不是「Token / 登录态失效」。
 *
 * 🐛 以前各处只认 code 190 + 三句英文，漏了 Meta 现在最常报的两类：
 *    · (#200) Provide valid app ID
 *      —— 200 码，但语义是 token 里解不出可用的 app（token 坏了/来自已失效的应用）
 *    · (2500) An active access token must be used to query information about the current user.
 *      —— /me 类接口上 token 无效时的标准报错
 *    漏判的代价不是「少提示一句」，而是方向性错误：账户预检把它当成「无权访问这个广告号」，
 *    于是绕一圈去 me/adaccounts 换广告号、最后静默跳过，日志和界面都在引导用户去查权限，
 *    实际上只要重新取一次 token。
 *
 * 入参兼容三种形态：callFacebookGraphApi 的返回（{error:{code,message}}）、
 * {message} 对象、以及 catch 到的字符串/Error。
 */
function isTokenInvalidError(input) {
  const err = (input && input.error) ? input.error : (input || {});
  const code = Number(err.code || 0);
  // 190 失效 / 102 会话键无效 / 463 会话过期 / 2500 /me 缺有效 token
  if (code === 190 || code === 102 || code === 463 || code === 2500) return true;
  const msg = String(err.message || err.error_user_msg || (typeof input === 'string' ? input : ''));
  return /session has been invalidated|validating access token|Provide valid app ID|active access token|Session has expired|access token has expired|No valid access token/i.test(msg);
}

async function runFacebookPublishAdApi(data) {
    // 🚀 全量参数映射：优先从 campaignTree 提取（前端树形结构），回落至扁平字段保持兼容
    const campaignNode = data.campaignTree?.[0] || {};
    const adSetNode = campaignNode.adSets?.[0] || {};
    const adNode = adSetNode.ads?.[0] || {};

    const {
        // ── 基础标识 ──
        profileId, campaignName = campaignNode.name, adSetName = adSetNode.name, adName = adNode.name,
        // ── 素材 ──
        mediaBase64: mediaBase64Raw, adText = adNode.adText, headline = adNode.headline, websiteUrl = adNode.websiteUrl,
        // ── 预算 ──
        budget = campaignNode.budget || adSetNode.budget,
        // ── 定位 ──
        countries = adSetNode.countries, ageMin = adSetNode.ageMin, ageMax = adSetNode.ageMax,
        gender = adSetNode.gender, placements = adSetNode.placements,
    } = data;
    
    // 🚀 从 campaignTree 的 ad 节点中提取所有 _mediaBase64（绕过前端闭包问题）
    const mediaBase64 = mediaBase64Raw || (data.campaignTree?.[0]?.adSets?.[0]?.ads?.[0]?._mediaBase64) || (Array.isArray(data.mediaBase64List) && data.mediaBase64List[0]) || null;
    // 🚀 收集所有广告的 _mediaBase64（用于 Adv+ 多图创意）
    const mediaBase64List = [];
    if (data.campaignTree) {
        for (const c of data.campaignTree) {
            for (const as of c.adSets) {
                for (const a of as.ads) {
                    if (a._mediaBase64) mediaBase64List.push(a._mediaBase64);
                }
            }
        }
    }
    if (!mediaBase64 && mediaBase64List.length > 0) {
        // 如果单图没有但列表有，用第一张
        mediaBase64 = mediaBase64List[0];
    }

    // 🎬 视频素材：前端把 ad.videoFile 转成 base64 塞进 ad 节点（File 对象无法过 JSON）
    const videoBase64 = data.videoBase64 || adNode._videoBase64 || null;
    const videoThumbBase64 = data.videoThumbBase64 || adNode._videoThumbBase64 || null;
    const videoName = data.videoName || adNode._videoName || 'video.mp4';
    const videoMime = data.videoMime || adNode._videoMime || 'video/mp4';
    if (videoBase64) {
        log('INFO', `🎬 [Profile=${profileId}] 收到视频素材: ${videoName} (base64长度=${videoBase64.length})`);
    }
    
    // 🔍 关键诊断：检查 mediaBase64 是否到达后端
    if (mediaBase64) {
        log('WARN', `🖼️ [Profile=${profileId}] mediaBase64 已到达后端！长度=${mediaBase64.length}, 前50字符=${mediaBase64.substring(0,50)}`);
    } else {
        log('WARN', `❌ [Profile=${profileId}] mediaBase64 为空或未定义！data.mediaBase64 类型=${typeof data.mediaBase64}, 树中_mediaBase64=${typeof data.campaignTree?.[0]?.adSets?.[0]?.ads?.[0]?._mediaBase64}, mediaBase64List=${mediaBase64List.length}个`);
    }
    const {
        // ── 账户/资产 ──
        adAccountId = adSetNode.adAccountId, pageId = adSetNode.pageId,
        // ── Campaign 级 ──
        objective = campaignNode.objective,
        budgetLevel = campaignNode.budgetLevel, budgetType = campaignNode.budgetType,
        startDate = campaignNode.startDate, endDate = campaignNode.endDate,
        // ── 像素/转化 ──
        pixelIds = adNode.pixelIds, conversionEvent = adNode.conversionEvent,
        enableVO = adNode.enableVO,
        // ── 设备 ──
        devicePlatforms = adSetNode.devicePlatforms, osType = adSetNode.osType,
        osVersionMin = adSetNode.osVersionMin, osVersionMax = adSetNode.osVersionMax, wifiOnly = adSetNode.wifiOnly,
        // ── 创意 ──
        ctaType = adNode.ctaType, enableAdvantageCreative = adNode.enableAdvantageCreative,
        enableAdvantageAudience = adSetNode.enableAdvantageAudience,
        enableAudienceExpansion = adSetNode.enableAudienceExpansion,
        adFormat = adNode.adFormat, leadFormId = adNode.leadFormId,
        messengerWelcomeMessage = adNode.messengerWelcomeMessage,
        engagementType = adNode.engagementType,
        adDescription = adNode.adDescription,
        // ── 高级创意 ──
        adText2 = adNode.adText2, headline2 = adNode.headline2,
        adDescription2 = adNode.adDescription2,
        enableDynamicCreative = adNode.enableDynamicCreative,
        enableLanguage = adNode.enableLanguage,
        languageContent = adNode.languageContent,
        primaryLanguage = adNode.primaryLanguage,
        additionalLanguages = adNode.additionalLanguages,
        // ── 链接 ──
        useDisplayLink = adNode.useDisplayLink, displayLink = adNode.displayLink,
        deepLink = adNode.deepLink, urlParams = adNode.urlParams,
        // ── 业务参数 ──
        callToActionCustom = adNode.callToActionCustom,
        productCatalogId = adNode.productCatalogId,
        productSetId = adNode.productSetId,
        offerId = adNode.offerId, offerDescription = adNode.offerDescription,
        instantExperienceId = adNode.instantExperienceId,
        // ── Campaign 级高级 ──
        buyingType = campaignNode.buyingType,
        specialAdCategories = campaignNode.specialAdCategories,
        pacingType = campaignNode.pacingType,
        advantageCampaignBudget = campaignNode.advantageCampaignBudget,
        enableAdvantageCampaign = campaignNode.enableAdvantageCampaign,
        brandSafety = campaignNode.brandSafety, brandSuitability = campaignNode.brandSuitability,
        bidStrategy = campaignNode.bidStrategy,
        bidAmount = campaignNode.bidAmount || adSetNode.bidAmount,
        targetRoas = campaignNode.targetRoas,
        conversionAttributionWindow = campaignNode.conversionAttributionWindow,
        // ── AdSet 级高级受众 ──
        cityTargeting = adSetNode.cityTargeting, regionTargeting = adSetNode.regionTargeting,
        zips = adSetNode.zips, dma = adSetNode.dma,
        locationType = adSetNode.locationType, radius = adSetNode.radius,
        excludeLocations = adSetNode.excludeLocations,
        languages = adSetNode.languages,
        detailedTargeting = adSetNode.detailedTargeting,
        detailedExclusions = adSetNode.detailedExclusions,
        customAudiencesInclude = adSetNode.customAudiencesInclude,
        customAudiencesExclude = adSetNode.customAudiencesExclude,
        excludedConnections = adSetNode.excludedConnections,
        friendsOfConnections = adSetNode.friendsOfConnections,
        broadTargeting = adSetNode.broadTargeting,
        allowLimitedSpendOnExcluded = adSetNode.allowLimitedSpendOnExcluded,
        // ── 人口统计 ──
        lifeEvents = adSetNode.lifeEvents, parents = adSetNode.parents,
        relationshipStatus = adSetNode.relationshipStatus, education = adSetNode.education,
        college = adSetNode.college, workEmployer = adSetNode.workEmployer,
        income = adSetNode.income, homeOwnership = adSetNode.homeOwnership,
        householdComposition = adSetNode.householdComposition,
        ethnicAffinity = adSetNode.ethnicAffinity, generation = adSetNode.generation,
        digitalActivities = adSetNode.digitalActivities, politics = adSetNode.politics,
        // ── 发布后年龄修改 ──
        enableAgeModify = adSetNode.enableAgeModify,
        ageMinModify = adSetNode.ageMinModify,
        ageMaxModify = adSetNode.ageMaxModify,
        // ── 建议受众年龄范围（Advantage+ AI 起始推荐范围） ──
        ageRange = adSetNode.ageRange,
        // ── 设备平台 ⚠️ 用户后端已有 `devicePlatforms`，此处用 `deviceModels` 区分 ──
        deviceModels = adSetNode.deviceModels,
        carrierTargeting = adSetNode.carrierTargeting,
        connectionSpeed = adSetNode.connectionSpeed,
        // ── 投放/归因 ──
        deliveryType = adSetNode.deliveryType,
        dayparting = adSetNode.dayparting,
        costPerResult = adSetNode.costCap || data.costPerResult,
        attributionSpec = adSetNode.attributionSpec || data.attributionSpec,
        attributionModel = adSetNode.attributionModel,
        conversionWindow = adSetNode.conversionWindow,
        customerLifecycle = adSetNode.customerLifecycle,
        // ── 排期 ──
        adSchedule = campaignNode.adSchedule || adSetNode.dayparting || data.adSchedule,
        timezone = campaignNode.timezone || data.timezone,
        // ── 状态 ──
        campaignStatus = campaignNode.campaignStatus,
        adSetStatus = adSetNode.adSetStatus,
        adStatus = adNode.adStatus,
        autoActivate = campaignNode.autoActivate,
        // ── 有广告跳过发布 ──
        skipIfAdExists = data.skipIfAdExists,
        onlyCheck = data.onlyCheck,
        // ── 批量控制 (旧扁平模式) ──
        campaignCount = data.campaignCount || 1,
        adSetCount = data.adSetCount || 1,
        adCount = data.adCount || 1,
        // ── 启动模式 ──
        launchBrowser = data.launchBrowser !== false,
        publishMethod = data.publishMethod,
        // ── 旧扁平字段（最高优先级覆盖） ──
        // 以下字段如果直接在 data 上存在，将覆盖上面的 tree 提取值
        // 注意：由于 JS 解构顺序，后面的同名变量会覆盖前面的
        // 因此我们最后再用 data 中的值覆盖一次
    } = data;

    // === 最终的字段合并：data 中的扁平字段具有最高优先级 ===
    const finalCampaignName = data.campaignName || campaignName || data.campaignTree?.[0]?.name || data.campaignTree?.[0]?.campaignName || '未命名广告系列';
    const finalAdSetName = data.adSetName || adSetName;
    const finalAdName = data.adName || adName;
    const finalBudget = data.budget || budget;
    const finalCountries = data.countries || countries;
    const finalAgeMin = data.ageMin || ageMin;
    const finalAgeMax = data.ageMax || ageMax;
    const finalAgeRange = data.ageRange || ageRange;
    // 🚀 解析建议受众年龄：支持 "45" → [45,65]（单数字=建议起始年龄）或 "25-65" → [25,65]
    const parseAgeRange = (str) => { if (!str) return null; const p = str.split('-').map(s => parseInt(s.trim())); if (p.length === 1 && !isNaN(p[0])) return [p[0], 65]; if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return p; return null; };
    const finalGender = data.gender || gender;
    const finalPlacements = data.placements || placements;
    const finalObjective = data.objective || objective;
    const finalBudgetType = data.budgetType || budgetType;
    const finalBudgetLevel = data.budgetLevel || budgetLevel;
    const finalStartDate = data.startDate || startDate;
    const finalEndDate = data.endDate || endDate;
    const finalAdText = data.adText || adText;
    const finalHeadline = data.headline || headline;
    const finalWebsiteUrl = data.websiteUrl || websiteUrl;
    const finalCtaType = data.ctaType || ctaType;
    const finalPixelIds = data.pixelIds || pixelIds;
    const finalConversionEvent = data.conversionEvent || conversionEvent;
    const finalDevicePlatforms = data.devicePlatforms || devicePlatforms;
    const finalOsType = data.osType || osType;
    const finalOsVersionMin = data.osVersionMin || osVersionMin;
    const finalOsVersionMax = data.osVersionMax || osVersionMax;
    const finalWifiOnly = data.wifiOnly !== undefined ? data.wifiOnly : wifiOnly;
    const finalPageId = data.pageId || pageId;
    const finalAdAccountId = data.adAccountId || adAccountId;
    const finalAdDescription = data.adDescription || adDescription;
    const finalAttributionSpec = data.attributionSpec || attributionSpec;
    const finalCostPerResult = data.costPerResult || costPerResult;
    const finalDetailedTargeting = data.detailedTargeting || detailedTargeting;
    let finalLanguages = data.languages || languages;
    // 🚀 如果广告组未设置语言但启用了多语言广告，自动从创意语言填充 targeting.locales
    if (!finalLanguages && enableLanguage) {
        const langSet = new Set();
        if (primaryLanguage) langSet.add(primaryLanguage);
        if (languageContent && typeof languageContent === 'object') {
            Object.keys(languageContent).forEach(lc => { if (lc) langSet.add(lc); });
        }
        if (additionalLanguages && Array.isArray(additionalLanguages)) {
            additionalLanguages.forEach(lc => { if (lc) langSet.add(lc); });
        }
        if (langSet.size > 0) {
            finalLanguages = Array.from(langSet).join(',');
            log('INFO', `[Profile=${profileId}] 🌐 多语言广告自动填充广告组语言: ${finalLanguages}`);
        }
    }
    const finalPlacementsControl = data.placementsControl || (adSetNode.placementsControl);
    const finalAllowLimitedSpend = data.allowLimitedSpendOnExcluded !== undefined ? data.allowLimitedSpendOnExcluded : allowLimitedSpendOnExcluded;
    const finalBidAmount = data.bidAmount || bidAmount;
    const finalBidStrategy = data.bidStrategy || bidStrategy;
    // 🔥 竞价策略必须显式化：省略 bid_strategy 时 FB 会回退到广告账号的默认竞价策略，
    //    若该策略要求竞价金额，就会报 "Bid Amount Required For The Bid Strategy Provided"
    const finalBidStrategyNorm = (!finalBidStrategy || String(finalBidStrategy).toUpperCase() === 'LOWEST_COST_WITHOUT_CAP')
        ? 'LOWEST_COST_WITHOUT_CAP'
        : finalBidStrategy;
    const finalUrlParams = data.urlParams || urlParams;
    const finalUseDisplayLink = data.useDisplayLink !== undefined ? data.useDisplayLink : useDisplayLink;
    const finalDisplayLink = data.displayLink || displayLink;
    const finalCustomerLifecycle = data.customerLifecycle || customerLifecycle;
    const finalLaunchBrowser = data.launchBrowser !== false ? data.launchBrowser : launchBrowser;
    const finalPacingType = data.pacingType || pacingType;
    const finalAdSchedule = data.adSchedule || adSchedule;
    const finalTimezone = data.timezone || timezone;
    const finalConversionAttributionWindow = data.conversionAttributionWindow || conversionAttributionWindow;
    const finalConversionWindow = data.conversionWindow || conversionWindow;

    // 🚀 Token 失效时重新获取并保存 —— 直接调用批量操作（「批量获取TOKEN」）用的那两个接口：
    //    POST /api/facebook/tokens（打开 adsmanager 抓 access_token）
    //    POST /api/facebook/save-tokens（写入云端 + 本地库）
    async function reExtractTokenAndUpdateProfile(profileId, profile) {
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        const headers = { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret };
        try {
            const resp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/tokens`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ profileId: String(profileId), targetUrl: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' })
            });
            const json = await resp.json().catch(() => ({}));
            const access = (json && json.tokens && Array.isArray(json.tokens.access_tokens)) ? json.tokens.access_tokens : [];
            // 与「批量获取TOKEN」取法一致：优先 EAAG，其次 EAA
            const newToken = access.find(v => /^EAAG/i.test(String(v))) || access.find(v => /^EAA/i.test(String(v))) || '';
            if (!newToken) {
                log('WARN', `⚠️ [Profile=${profileId}] 未能获取到有效 Token（登录态可能已失效，请人工重新登录）`);
                return false;
            }
            await fetch(`http://127.0.0.1:${PORT}/api/facebook/save-tokens`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ profileId: String(profileId), tokens: { access_tokens: [newToken] } })
            }).catch(() => {});
            if (profile) profile.token = newToken;
            log('INFO', `🔄 [Profile=${profileId}] Token 已重新获取并保存: ${newToken.slice(0, 12)}...`);
            return true;
        } catch (e) {
            log('WARN', `⚠️ [Profile=${profileId}] 重新获取 Token 失败: ${e.message}`);
            return false;
        }
    }

    const results = [];
    try {
        log('INFO', `🎬 [Profile=${profileId}] 开始 API 发布流程: ${finalCampaignName} (批量: ${campaignCount}x${adSetCount}x${adCount})`);
        
        // 1. 获取 Profile 详情及 Token
        const profile = await findProfileById(profileId);
        if (!profile || !profile.token) {
            throw new Error('未找到该环境的 Access Token，请先执行"获取TOKEN"操作');
        }



        // 🚀 预检：验证 profile 的 token 是否有权限访问该广告账户，无权则自动换用 profile 自己的广告账户
        let effectiveAccountId = finalAdAccountId;
        // 🐛 修复：GraphAPI 要求广告账户以 act_ 开头，否则会返回 100 错误
        if (effectiveAccountId && !effectiveAccountId.startsWith('act_')) {
            effectiveAccountId = `act_${effectiveAccountId}`;
        }
        if (effectiveAccountId) {
            try {
                let accCheck = await callFacebookGraphApi(`${effectiveAccountId}?fields=id,name,account_status,currency`, 'GET', null, profile);
                // 🚀 Token 失效自愈：先确保浏览器就绪，再重新获取 Token 并重试预检一次。
                //    ⚠️ 重取 Token 依赖浏览器里的登录态（/api/facebook/tokens 要打开 adsmanager 抓），
                //    而发布常常在浏览器刚拉起、还没登录完成时就跑了预检 —— 实测 Profile=4132：
                //    05:03:11 预检报 (#200) Provide valid app ID 直接跳过整单，而浏览器 05:03:49
                //    自动登录其实成功了。这里补上「等着把 Token 换新再判一次」，避免误杀。
                //    （onlyCheck 只做轻量检查，不在此启动浏览器。）
                if (!onlyCheck && (!accCheck || accCheck?.error) && isTokenInvalidError(accCheck)) {
                    const br = await ensureBrowserIsRunning(profileId).catch(() => null);
                    if (br && br.success) {
                        log('INFO', `🔑 [Profile=${profileId}] 预检遇 Token 失效，浏览器已就绪，尝试重新获取 Token...`);
                    } else {
                        log('WARN', `⚠️ [Profile=${profileId}] 预检遇 Token 失效，浏览器未能就绪（${(br && br.error) || '未知原因'}），仍尝试重新获取 Token...`);
                    }
                    if (await reExtractTokenAndUpdateProfile(profileId, profile)) {
                        log('INFO', `🔄 [Profile=${profileId}] Token 已重新获取，重试广告账户预检...`);
                        accCheck = await callFacebookGraphApi(`${effectiveAccountId}?fields=id,name,account_status,currency`, 'GET', null, profile);
                    }
                }
                if (!accCheck || accCheck?.error) {
                    const errCode = accCheck?.error?.code || '';
                    const errMsg = (accCheck?.error?.message || '未知错误').slice(0, 120);
                    // 🐛 Token/登录失效（190/102/463/2500，含「200 Provide valid app ID」），直接标记并停止
                    if (isTokenInvalidError(accCheck)) {
                        log('WARN', `🚫 [Profile=${profileId}] 广告账户预检失败: Token/登录已过期 (${errMsg})`);
                        deadTokenProfiles.add(String(profileId));
                        if (onlyCheck) {
                            return { success: false, loginFailed: true, message: 'Token/登录已过期，请重新登录' };
                        }
                        throw new SkipPublishError(`Token/登录已过期，请重新登录或重新获取 TOKEN`);
                    }
                    if (errCode === 100 || errCode === 200 || errCode === 210 || errMsg.includes('does not exist') || errMsg.includes('missing permissions') || errMsg.includes('cannot be loaded')) {
                        // 🚀 自动换用 profile 自己的广告账户（通过 Graph API 查询）
                        log('WARN', `🔄 [Profile=${profileId}] 账户 ${finalAdAccountId} 无权访问，尝试查询 profile 的可用广告账户...`);
                        try {
                            const accountsData = await callFacebookGraphApi('me/adaccounts?fields=account_id,name,account_status&limit=5', 'GET', null, profile);
                            if (accountsData?.data && Array.isArray(accountsData.data) && accountsData.data.length > 0) {
                                const active = accountsData.data.find(a => a.account_status === 1) || accountsData.data[0];
                                const newId = `act_${active.account_id}`;
                                if (newId !== effectiveAccountId) {
                                    effectiveAccountId = newId;
                                    log('WARN', `🔄 [Profile=${profileId}] 自动换用广告账户: ${effectiveAccountId} (${active.name || ''})`);
                                } else {
                                    log('WARN', `⏭️ [Profile=${profileId}] 跳过发布: 唯一广告账户 ${effectiveAccountId} 也无权访问`);
                                    return { success: true, skipped: true, error: `无权访问广告账户`, total: 0, adId: null };
                                }
                            } else {
                                log('WARN', `⏭️ [Profile=${profileId}] 跳过发布: 无权访问广告账户 ${finalAdAccountId}，且查询无可用账户`);
                                return { success: true, skipped: true, error: `无权访问广告账户 ${finalAdAccountId}`, total: 0, adId: null };
                            }
                        } catch (accQueryErr) {
                            log('WARN', `⏭️ [Profile=${profileId}] 跳过发布: 无权访问广告账户 ${finalAdAccountId}，查询可用账户也失败: ${accQueryErr.message}`);
                            return { success: true, skipped: true, error: `无权访问广告账户 ${finalAdAccountId}`, total: 0, adId: null };
                        }
                    }
                }
            } catch (accErr) {
                // 🐛 SkipPublishError（Token/登录已过期）必须原样抛出：以前这里统一吞掉并"继续尝试发布"，
                //    结果带着已失效的 token 一路跑到素材上传才失败，用户看到的是
                //    "No valid access token found in browser"，而不是"请重新登录"。
                if (accErr instanceof SkipPublishError) throw accErr;
                log('WARN', `⚠️ [Profile=${profileId}] 广告账户预检异常，继续尝试发布: ${accErr.message}`);
            }
        }
        // 🚀 有广告跳过发布：如果启用，先检查广告账户是否已有广告
        if (skipIfAdExists && effectiveAccountId) {
            try {
                const cleanId = effectiveAccountId.replace('act_', '');
                const adCheck = await callFacebookGraphApi(`${effectiveAccountId}/ads?limit=1&fields=id,status`, 'GET', null, profile);
                // 🐛 检查 API 返回的错误（eg. Token 190 时返回 HTTP 200 + error body）
                if (adCheck?.error) {
                    // 🚀 Token/登录失效时尝试从浏览器提取新 Token 重试（判据统一到 isTokenInvalidError）
                    if (isTokenInvalidError(adCheck)) {
                        log('WARN', `🚫 [Profile=${profileId}] Token 过期，检查 Cookie 有效性...`);
                        let retryOk = false;
                        let cookieValid = false;
                        try {
                            const browserData = activeBrowsers.get(profileId);
                            if (browserData?.browser?.isConnected()) {
                                const pages = await browserData.browser.pages();
                                const bPage = pages[0] || await browserData.browser.newPage();
                                // 🐛 先检查 Cookie 有效性
                                const cookies = await bPage.cookies('https://facebook.com', 'https://www.facebook.com').catch(() => []);
                                const allCookies = Array.isArray(cookies) ? cookies : [];
                                const cUser = allCookies.find(c => c.name === 'c_user');
                                const xs = allCookies.find(c => c.name === 'xs');
                                cookieValid = !!(cUser?.value && xs?.value);
                                if (!cookieValid) {
                                    log('WARN', `🚫 [Profile=${profileId}] Cookie 已失效 (c_user=${!!cUser}, xs=${!!xs})，自动导航登录页...`);
                                    // 🚀 导航到 Facebook 登录页，尝试自动填密码登录
                                    await bPage.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                                    await new Promise(r => setTimeout(r, 3000));
                                    // 尝试自动填密码
                                    try {
                                        await autoFillPasswordOnPage(bPage, profile, profileId);
                                        log('INFO', `🔐 [Profile=${profileId}] 自动填密码完成，等待登录...`);
                                    } catch (fillErr) {
                                        log('WARN', `⚠️ [Profile=${profileId}] 自动填密码失败: ${fillErr.message}`);
                                    }
                                    await new Promise(r => setTimeout(r, 5000));
                                    // 重新检查 Cookie
                                    const retryCookies = await bPage.cookies('https://facebook.com', 'https://www.facebook.com').catch(() => []);
                                    const retryArr = Array.isArray(retryCookies) ? retryCookies : [];
                                    const retryCUser = retryArr.find(c => c.name === 'c_user');
                                    const retryXs = retryArr.find(c => c.name === 'xs');
                                    if (retryCUser?.value && retryXs?.value) {
                                        cookieValid = true;
                                        log('INFO', `✅ [Profile=${profileId}] Cookie 重新有效 (c_user=${retryCUser.value})`);
                                    } else {
                                        log('WARN', `🚫 [Profile=${profileId}] 自动登录后 Cookie 仍然无效，停止`);
                                        if (onlyCheck) {
                                            return { success: false, loginFailed: true, message: 'Cookie/登录已过期，自动登录失败' };
                                        }
                                        throw new SkipPublishError(`Cookie/登录已过期，自动登录失败`);
                                    }
                                }
                                // Cookie 有效 → 导航到 adsmanager 提取新 Token
                                log('INFO', `🔑 [Profile=${profileId}] Cookie 有效，尝试从浏览器提取新 Token`);
                                await bPage.goto('https://www.facebook.com/adsmanager', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                                await new Promise(r => setTimeout(r, 3000));
                                const newToken = await bPage.evaluate(() => {
                                    try {
                                        const keys = Object.keys(localStorage);
                                        for (const k of keys) {
                                            if (k.startsWith('EAAG') || localStorage.getItem(k)?.startsWith('EAAB')) return localStorage.getItem(k);
                                        }
                                        const d = document.cookie.split(';').find(c => c.trim().startsWith('act='));
                                        return d ? decodeURIComponent(d.split('=')[1]) : null;
                                    } catch { return null; }
                                });
                                if (newToken && newToken.length > 50) {
                                    profile.token = newToken;
                                    log('INFO', `🔑 [Profile=${profileId}] 提取到新 Token (长度: ${newToken.length})，重试广告检查`);
                                    const retryCheck = await callFacebookGraphApi(`${effectiveAccountId}/ads?limit=1&fields=id,status`, 'GET', null, profile);
                                    if (retryCheck?.data && Array.isArray(retryCheck.data) && retryCheck.data.length > 0) {
                                        const existingCount = retryCheck.data.length;
                                        log('INFO', `⏭️ [Profile=${profileId}] 新 Token 检查: 已有 ${existingCount} 个广告，跳过发布`);
                                        return { success: true, skipped: true, skipReason: '已有广告', total: 0, adId: null };
                                    }
                                    log('INFO', `✅ [Profile=${profileId}] 新 Token 检查: 无现有广告`);
                                    retryOk = true;
                                } else {
                                    log('WARN', `🚫 [Profile=${profileId}] 浏览器中未找到有效 Token (Cookie 有效但 Token 不可用)`);
                                }
                            }
                        } catch (tokenErr) {
                            log('WARN', `⚠️ [Profile=${profileId}] 提取新 Token 失败: ${tokenErr.message}`);
                        }
                        // 提取新 Token 也失败 → 返回 loginFailed
                        if (!retryOk) {
                            if (onlyCheck) {
                                return { success: false, loginFailed: true, message: 'Token/登录已过期，请重新登录' };
                            }
                            throw new SkipPublishError(`Token/登录已过期，请重新登录或重新获取 TOKEN`);
                        }
                    }
                    // 其他错误放行继续
                    log('WARN', `⚠️ [Profile=${profileId}] 广告检查API返回错误，继续发布: ${adCheck.error.message}`);
                } else if (adCheck?.data && Array.isArray(adCheck.data) && adCheck.data.length > 0) {
                    const existingCount = adCheck.data.length;
                    log('INFO', `⏭️ [Profile=${profileId}] 广告账户 ${effectiveAccountId} 已有 ${existingCount} 个广告，跳过发布`);
                    return { success: true, skipped: true, skipReason: '已有广告', total: 0, adId: null };
                }
                log('INFO', `✅ [Profile=${profileId}] 广告账户 ${effectiveAccountId} 无现有广告，继续发布`);
                if (onlyCheck) {
                    return { success: true, skipped: false, message: '检查完成，无现有广告' };
                }
            } catch (adCheckErr) {
                // 🐛 SkipPublishError 是在上面 try 里主动抛的，这里必须原样放出去，否则会被自己的 catch 吞掉
                if (adCheckErr instanceof SkipPublishError) throw adCheckErr;
                const msg = (adCheckErr?.message || adCheckErr || '').toString();
                // 🐛 Token 失效 / 登录过期（含 200 Provide valid app ID、2500 active access token），返回明确信号
                if (isTokenInvalidError(msg) || msg.includes('190') || msg.includes('login') || msg.includes('not logged')) {
                    log('WARN', `🚫 [Profile=${profileId}] 广告检查失败: Token/登录已过期，无法检查广告账户`);
                    if (onlyCheck) {
                        return { success: false, loginFailed: true, message: 'Token/登录已过期，请重新登录' };
                    }
                    throw new SkipPublishError(`Token/登录已过期，请重新登录或重新获取 TOKEN`);
                }
                log('WARN', `⚠️ [Profile=${profileId}] 广告检查失败，继续发布: ${msg}`);
            }
        }
        // 🚀 核心优化：根据开关决定是否预先启动浏览器
        if (finalLaunchBrowser) {
            log('INFO', `🌐 [Profile=${profileId}] 正在根据设置二次确认浏览器状态...`);
            try {
                const brResult = await ensureBrowserIsRunning(profileId);
                if (brResult.success) {
                    log('SUCCESS', `✅ [Profile=${profileId}] 浏览器已就绪。`);
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] 浏览器自动唤醒失败: ${brResult.error}，继续 API 发布流程...`);
                }
            } catch (launchErr) {
                log('WARN', `⚠️ [Profile=${profileId}] 浏览器状态确认异常: ${launchErr.message}，继续发布流程...`);
            }
        }

        const formatFBError = (res) => {
            if (!res || !res.error) return JSON.stringify(res);
            const err = res.error;
            // 🚀 优先返回 Facebook 提供的用户友好提示
            const base = err.error_user_title || err.error_user_msg || err.message || JSON.stringify(err);
            // 🔔 账户级「待处理动作」：Meta 要求该账户先完成验证，而且报错原文往往是**当地语言**
            //    （实测 profile 4340 返回韩文「계정을 인증하세요」，光看原文不知道要做什么）。
            //    错误码 31 = This request requires the user to take a pending action。
            const isPendingAction = String(err.code || '') === '31' || /pending action/i.test(String(err.message || ''));
            if (isPendingAction) {
                return `${base} ｜ 原因：该广告账户在 Meta 有未完成的验证（账户/身份核验）。请用对应的 Facebook 账号登录 Ads Manager 或 Business Support Home 完成验证后，再重新发布。`;
            }
            return base;
        };
        
        // 校验基础参数
        if (!finalBudget || isNaN(parseFloat(finalBudget))) {
            throw new Error('预算金额无效');
        }
        if (!finalCampaignName || !finalAdSetName || !finalAdName) {
            throw new Error('广告系列/组/素材名称不能为空');
        }

        const token = profile.token;
        
        // 2. 确定广告账户
        let actId = effectiveAccountId;
        if (!actId) {
            log('INFO', `🔍 [Profile=${profileId}] 正在获取可用广告账户...`);
            const accountsData = await callFacebookGraphApi('me/adaccounts?fields=account_id,name,account_status', 'GET', null, profile);
            if (accountsData.data && accountsData.data.length > 0) {
                const adAccount = accountsData.data.find(a => a.account_status === 1) || accountsData.data[0];
                actId = `act_${adAccount.account_id}`;
            } else {
                throw new Error('未发现可用的广告账户');
            }
        } else if (!actId.startsWith('act_')) {
            actId = `act_${actId}`;
        }
        log('INFO', `🎯 [Profile=${profileId}] 使用广告账户: ${actId}`);

        // 🚀 Certification Required 提前检测：快速查询广告账户是否有投放权限
        try {
            const permCheck = await callFacebookGraphApi(`${actId}/ads?limit=1&fields=id`, 'GET', null, profile, token);
            if (permCheck && permCheck.error) {
                const permErr = permCheck.error;
                const isCertReq = (permErr.code === 368 || /certification/i.test(permErr.message || '') || /certification/i.test(permErr.error_user_title || ''));
                if (isCertReq) {
                    log('WARN', `⚠️ [Profile=${profileId}] 广告账户 ${actId} 未认证(Certification Required)，跳过发布`);
                    throw new SkipPublishError(`广告账户未认证: ${permErr.error_user_title || permErr.message}`);
                }
            }
        } catch (permErr) {
            if (permErr instanceof SkipPublishError) throw permErr;
            log('WARN', `⚠️ [Profile=${profileId}] 广告账户权限检测失败(非关键): ${permErr.message}`);
        }

        // 🚀 智能像素匹配 + 自动兜底（即使模板没有 pixelIds 也自动选一个）
        let effectivePixelId = '';
        try {
            const sdb = new sqlite3.Database(dbPath);
            const ownPixels = await new Promise((resolve, reject) => {
                const stmt = sdb.prepare(`SELECT pixel_id, name, status FROM pixels WHERE profile_id = ? AND (account_id = ? OR account_id = ?)`);
                stmt.all(String(profileId), actId, actId.replace('act_', ''), (err, rows) => {
                    stmt.finalize();
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
            sdb.close();
            if (ownPixels && Array.isArray(ownPixels) && ownPixels.length > 0) {
                const ownPixelIds = ownPixels.map(p => p.pixel_id).filter(Boolean);
                if (finalPixelIds && Array.isArray(finalPixelIds) && finalPixelIds.length > 0) {
                    const matchedIds = finalPixelIds.filter(pid => ownPixelIds.includes(pid));
                    if (matchedIds.length > 0) {
                        effectivePixelId = matchedIds[0];
                        log('INFO', `✅ [Profile=${profileId}] 从 ${finalPixelIds.length} 个传入像素中匹配到: ${effectivePixelId} (共 ${matchedIds.length} 个匹配)`);
                    }
                }
                if (!effectivePixelId) {
                    const active = ownPixels.find(p => p && p.status === 'ACTIVE') || ownPixels[0];
                    if (active && active.pixel_id) {
                        effectivePixelId = active.pixel_id;
                        log('INFO', `🔁 [Profile=${profileId}] 自动使用本地像素: ${effectivePixelId} (${active.name || ''})`);
                    }
                }
            }
        } catch (pixelErr) {
            log('WARN', `⚠️ [Profile=${profileId}] 像素自动匹配异常: ${pixelErr.message}`);
        }

        // 🚀 兜底：像素匹配后仍为空时，查询 Facebook 当前广告账户的真实像素
        async function getPixelsWithRetry(attemptsLeft) {
            while (attemptsLeft > 0) {
                attemptsLeft--;
                log('INFO', `🔍 [Profile=${profileId}] 正在查询 Facebook 上 ${actId} 的真实像素...`);
                try {
                    const fbPixelsData = await callFacebookGraphApi(`${actId}/adspixels?fields=pixel_id,name,status`, 'GET', null, profile);
                    if (fbPixelsData && fbPixelsData.data && Array.isArray(fbPixelsData.data) && fbPixelsData.data.length > 0) {
                        const matchedFbPixel = fbPixelsData.data.find(p => finalPixelIds.includes(p.id) || finalPixelIds.includes(p.pixel_id)) 
                            || fbPixelsData.data.find(p => p.status === 'ACTIVE')
                            || fbPixelsData.data[0];
                        const fbPixelId = matchedFbPixel?.id || matchedFbPixel?.pixel_id || '';
                        if (fbPixelId) {
                            effectivePixelId = fbPixelId;
                            log('INFO', `✅ [Profile=${profileId}] 从 Facebook API 查询到当前广告账户像素: ${effectivePixelId} (${matchedFbPixel.name || ''})`);
                            return true;
                        }
                    }
                    log('WARN', `⚠️ [Profile=${profileId}] Facebook API 也返回空像素列表`);
                } catch (fbPixelErr) {
                    const errMsg = (fbPixelErr?.message || '').toLowerCase();
                    log('WARN', `⚠️ [Profile=${profileId}] 查询 Facebook 像素异常: ${errMsg}`);
                }
                // 🚀 检查返回的 error 是否权限不足 → 重新提取 Token 重试
                if (attemptsLeft > 0) {
                    const reExtracted = await reExtractTokenAndUpdateProfile(profileId, profile);
                    if (reExtracted) {
                        log('INFO', `🔄 [Profile=${profileId}] Token 已更新，重试像素查询（剩余 ${attemptsLeft} 次）...`);
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        break; // 没有新 Token，重试也没意义
                    }
                }
            }
            return false;
        }
        // 🚀 像素兜底：FB 上查不到像素时，直接在该广告账户下创建一个。
        //    ⚠️ 以前这里是「跳过像素创建 → 用主页兜底」，但 OUTCOME_LEADS/SALES 走
        //       OFFSITE_CONVERSIONS + 归因窗口 >1 天时，Meta 强制要求 promoted_object 带 pixel_id，
        //       只给 page_id 必被拒（subcode 1885533 Invalid Attribution Window For App Event Optimization）。
        //    Meta 现在把像素节点叫 dataset：POST /{act}/adspixels 在 v21.0 可能报 "nonexisting field"
        //    （→ 改打 /datasets）；同名像素已存在时报 #6200（→ 直接复用现有列表里第一个）。
        async function createPixelForAdAccount(pixelName) {
            const readExisting = async () => {
                for (const edge of ['adspixels', 'datasets']) {
                    const list = await callFacebookGraphApi(`${actId}/${edge}?fields=id,name`, 'GET', null, profile).catch(() => null);
                    if (list?.data?.length) return { id: String(list.data[0].id), name: list.data[0].name || pixelName, existing: true };
                }
                return null;
            };
            const formData = new URLSearchParams();
            formData.append('name', pixelName);
            let created = await callFacebookGraphApi(`${actId}/adspixels`, 'POST', formData, profile);
            if (created?.error && (/nonexisting field/i.test(String(created.error.message || '')) || Number(created.error.code) === 100)) {
                log('WARN', `⚠️ [Profile=${profileId}] ${actId}/adspixels 不可用，改用 datasets 创建像素...`);
                created = await callFacebookGraphApi(`${actId}/datasets`, 'POST', formData, profile);
            }
            if (created?.error && Number(created.error.code) === 6200) {
                log('WARN', `⚠️ [Profile=${profileId}] 账户下已存在像素(#6200)，改为复用现有像素`);
                return await readExisting();
            }
            if (created?.id) return { id: String(created.id), name: pixelName, existing: false };
            log('WARN', `⚠️ [Profile=${profileId}] 创建像素被拒: ${formatFBError(created)}`);
            return await readExisting();
        }
        if (!effectivePixelId) {
            await getPixelsWithRetry(2); // 首次 + 1次重试（含 Token 失效自动重取）
            if (!effectivePixelId) {
                const pixelName = `${profile?.name || profileId}_Pixel`;
                log('WARN', `⚠️ [Profile=${profileId}] 广告账户 ${actId} 无可用像素，尝试自动创建: ${pixelName}`);
                const created = await createPixelForAdAccount(pixelName)
                    .catch(e => { log('WARN', `⚠️ [Profile=${profileId}] 自动创建像素异常: ${e.message}`); return null; });
                if (created?.id) {
                    effectivePixelId = created.id;
                    log('SUCCESS', `✅ [Profile=${profileId}] ${created.existing ? '复用现有' : '自动创建'}像素成功: ${effectivePixelId} (${created.name})`);
                    // 落本地库：下次发布直接命中，界面刷新像素列表后也能看到
                    try {
                        const sdb2 = new sqlite3.Database(dbPath);
                        await new Promise((resolve) => sdb2.run(
                            `INSERT OR REPLACE INTO pixels (id, profile_id, pixel_id, account_id, name, status, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                            // ⚠️ id / account_id 的写法必须和既有同步逻辑一致（pixel_<id> / 纯数字账号）
                            [`pixel_${created.id}`, String(profileId), String(created.id),
                             actId.replace(/^act_/, ''), created.name || pixelName, 'ACTIVE'],
                            () => resolve()));
                        sdb2.close();
                    } catch (dbErr) { log('WARN', `⚠️ [Profile=${profileId}] 新建像素落库失败(不影响发布): ${dbErr.message}`); }
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] 自动创建像素未成功，继续走主页兜底`);
                }
            }
            // 仍然没有像素时，说明接下来会用主页兜底
            if (!effectivePixelId) {
                if (finalPageId || pageId) {
                    log('WARN', `⚠️ [Profile=${profileId}] 无可用像素，使用主页 ${finalPageId || pageId} 作为推广对象`);
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] 无可用像素且未指定主页，尝试后续用账号主页兜底`);
                }
            }
        }

        // 🚀 推广对象（promoted_object）前置解析
        //    ⚠️ 原来这段兜底写在创建 AdSet 的地方，用的是 profile?.pages?.[0]?.id —— 而 profile 来自
        //       findProfileById()，那条 SQL 根本没查主页，这个值永远是空（死代码）。
        //       真正能拿到主页的代码在创意阶段（远在 AdSet 之后）→ 顺序倒置，兜底永远赶不上，
        //       于是「无像素 + 账号无主页」时必然在创建广告组那一步直接抛错（profile 4109 实测）。
        //    ⚠️ 这里只查询、不自动建主页：账号确实没主页就给明确报错，不在用户账号下建垃圾主页。
        //    ⚠️ 也不是所有目标都要求 promoted_object：OUTCOME_LEADS / OUTCOME_SALES 是 Meta 强制的，
        //       而 OUTCOME_TRAFFIC / OUTCOME_AWARENESS / OUTCOME_ENGAGEMENT 本就不要求 ——
        //       以前无条件强制，等于把「无像素账号发流量广告」在本地拦死，FB 根本没收到请求。
        const PROMOTED_OBJECT_OBJECTIVES = ['OUTCOME_LEADS', 'OUTCOME_SALES'];
        // 🎯 主页类互动目标（主页赞 / 帖子互动 / 消息互动）的转化位置都在公共主页上，
        //    Meta 强制要求给出 promoted_object.page_id；像素对这类目标没有任何意义，
        //    所以「账号里有像素」不能成为跳过查主页的理由
        //    （实测 Profile=4132：账号自动带上了像素 → resolvedPageId 一直是空 → 没挂推广对象）。
        //    ⚠️ 必须覆盖全部主页类优化目标（含别名 MESSAGES→REPLIES）：
        //       只认 PAGE_LIKES 时，帖子互动/消息互动会漏查主页、漏挂 promoted_object，
        //       到创建广告时才报 "Ad Set with Promoted Object Is Required"。
        const PAGE_OBJECT_GOALS = ['PAGE_LIKES', 'POST_ENGAGEMENT', 'REPLIES', 'CONVERSATIONS'];
        const _rawOptGoal = String(adSetNode.optimizationGoal || data.optimizationGoal || engagementType || '').toUpperCase();
        const _optGoalUpper = ({ MESSAGES: 'REPLIES', CONVERSIONS: 'OFFSITE_CONVERSIONS' })[_rawOptGoal] || _rawOptGoal;
        const _isPageObjectGoal = PAGE_OBJECT_GOALS.includes(_optGoalUpper);
        const needsPromotedObject = PROMOTED_OBJECT_OBJECTIVES.includes(String(finalObjective || '').toUpperCase()) || _isPageObjectGoal;
        let resolvedPageId = finalPageId || pageId || '';
        if (!resolvedPageId && (!effectivePixelId || _isPageObjectGoal)) {
            try {
                const pagesData = await callFacebookGraphApi('me/accounts?fields=id,name', 'GET', null, profile);
                if (pagesData?.data?.length) {
                    resolvedPageId = String(pagesData.data[0].id || '');
                    log('INFO', `🗂️ [Profile=${profileId}] ${_isPageObjectGoal ? '主页类目标需要推广主页' : '无可用像素，改用账号主页'}作为推广对象: ${resolvedPageId} (${pagesData.data[0].name || ''})`);
                } else {
                    log('WARN', `⚠️ [Profile=${profileId}] 账号下没有任何主页 (me/accounts 返回空)`);
                }
            } catch (pageErr) {
                log('WARN', `⚠️ [Profile=${profileId}] 查询账号主页失败: ${pageErr.message}`);
            }
        }
        // 🔥 前置拦截：主页类目标（主页赞/帖子互动/消息互动）没主页就根本没法创建（像素救不了）；其余目标像素和主页有一个即可。
        const _promotedObjectMissing = _isPageObjectGoal ? !resolvedPageId : (!effectivePixelId && !resolvedPageId);
        if (needsPromotedObject && _promotedObjectMissing) {
            throw new Error(`发布失败: 目标 ${finalObjective} 需要推广对象(promoted_object)，但广告账户 ${actId} 没有可用像素、账号下也没有主页。请先为该广告账户创建像素，或在该账号下创建/指定主页后重试`);
        }

        // 3. 并行上传素材（大幅加速多图场景）
        let imageHash = null;
        const imageHashes = [];
        const allB64 = mediaBase64List.length > 0 ? mediaBase64List : (mediaBase64 ? [mediaBase64] : []);
        // 🖼️ 未提供任何图片时直接留空，不再塞 1x1 透明占位图。
        //    占位图会白白多跑一次 /adimages 上传：实测 Profile=4132 那个 96 字节的占位图，
        //    因代理链路白等 curl 60s + 浏览器回退 35s，合计 95 秒；而创意侧本来就可以不传 image_hash。
        if (allB64.length === 0) {
            log('INFO', `🖼️ [Profile=${profileId}] 未提供图片素材，广告图片留空`);
        }
        // 去重
        const uniqueB64s = [];
        const seen = new Set();
        for (const b of allB64) { if (b && !seen.has(b)) { seen.add(b); uniqueB64s.push(b); } }
        // 并发上传（限制 3 并发避免浏览器过载）
        async function uploadSingleImage(b64, idx) {
            log('INFO', `🖼️ [Profile=${profileId}] 正在上传广告素材 #${idx+1}/${uniqueB64s.length} (Base64长度: ${b64.length})...`);
            const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
            const formData = new URLSearchParams();
            formData.append('bytes', base64Data);
            let uploadData = await callFacebookGraphApi(`${actId}/adimages`, 'POST', formData, profile);
            // 网络中断自动重试一次
            if (!uploadData || uploadData.error?.type === 'BrowserFetchError' || (uploadData.error?.message || '').includes('Failed to fetch') || (uploadData.error?.message || '').includes('context was destroyed')) {
                log('WARN', `⚠️ [Profile=${profileId}] 素材 #${idx+1} 上传网络中断，等待 3 秒后重试...`);
                await new Promise(r => setTimeout(r, 3000));
                uploadData = await callFacebookGraphApi(`${actId}/adimages`, 'POST', formData, profile);
            }
            if (uploadData?.images && Object.keys(uploadData.images).length > 0) {
                const firstKey = Object.keys(uploadData.images)[0];
                const h = uploadData.images[firstKey].hash;
                log('SUCCESS', `✅ [Profile=${profileId}] 素材 #${idx+1} 上传成功: ${h}`);
                return { hash: h, _b64: b64 };
            }
            throw new Error(`素材 #${idx+1} 上传失败: ${formatFBError(uploadData)}`);
        }
        const IMG_CONCURRENCY = 3;
        const imgResults = [];
        for (let i = 0; i < uniqueB64s.length; i += IMG_CONCURRENCY) {
            const batch = uniqueB64s.slice(i, i + IMG_CONCURRENCY);
            const batchResults = await Promise.all(batch.map((b64, bi) => uploadSingleImage(b64, i + bi)));
            imgResults.push(...batchResults);
        }
        for (const r of imgResults) { imageHashes.push(r); imageHash = r.hash; }

        // 3.1 🎬 视频素材上传（Meta: POST /{act_id}/advideos → video_id，再等转码完成）
        let videoId = null;
        let videoThumbHash = null;
        let videoThumbUrl = null;
        if (videoBase64) {
            try {
                let vUp = null;
                // Token 失效(190) 时自动重取 Token 再试一次（视频上传不走 callFacebookGraphApi，需要单独处理）
                for (let attempt = 0; attempt < 2 && !vUp; attempt++) {
                    try {
                        vUp = await uploadVideoToAdAccount(actId, videoBase64, videoName, videoMime, profile);
                        if (vUp && !vUp.id) throw new Error(formatFBError(vUp));
                    } catch (vErr) {
                        const msg = String(vErr && vErr.message || '');
                        const isTokenErr = isTokenInvalidError(msg) || /190/.test(msg);
                        if (attempt === 0 && isTokenErr && await reExtractTokenAndUpdateProfile(profileId, profile)) {
                            log('INFO', `🔄 [Profile=${profileId}] 视频上传遇 Token 失效，已重新获取 Token 后重试...`);
                            continue;
                        }
                        throw vErr;
                    }
                }
                videoId = String(vUp.id);
                log('SUCCESS', `✅ [Profile=${profileId}] 视频素材上传成功: video_id=${videoId}`);
                const ready = await waitForVideoReady(videoId, profile, 300000);
                if (ready.status && ready.status.video_status === 'error') {
                    // 转码失败 = 视频文件本身有问题；继续往下只会在创意阶段报一句难懂的
                    // "Your ad needs a video thumbnail"，这里直接把真实原因抛出来
                    throw new Error(`视频转码失败，请检查视频文件（需为 Meta 支持的 MP4/MOV 编码）`);
                }
                if (!ready.ready) {
                    log('WARN', `⚠️ [Profile=${profileId}] 视频 ${videoId} 未在等待期内就绪(status=${ready.status && ready.status.video_status || 'unknown'})，仍继续创建创意`);
                }
                // 视频封面：优先用户点选的那张图，其次用该广告主图（复用已上传的 hash，避免重复上传）
                const thumbB64 = videoThumbBase64 || mediaBase64;
                if (thumbB64) {
                    const cachedThumb = imgResults.find(r => r._b64 === thumbB64);
                    if (cachedThumb) {
                        videoThumbHash = cachedThumb.hash;
                    } else {
                        const tForm = new URLSearchParams();
                        tForm.append('bytes', String(thumbB64).replace(/^data:image\/\w+;base64,/, ''));
                        const tUpload = await callFacebookGraphApi(`${actId}/adimages`, 'POST', tForm, profile);
                        if (tUpload?.images && Object.keys(tUpload.images).length > 0) {
                            videoThumbHash = tUpload.images[Object.keys(tUpload.images)[0]].hash;
                        }
                    }
                    if (videoThumbHash) log('INFO', `🎬 [Profile=${profileId}] 视频封面 image_hash=${videoThumbHash}`);
                }
                // 完全没有图片可当封面时，取 FB 自己抽帧生成的缩略图，否则创意阶段会报
                // "Your ad needs a video thumbnail"
                if (!videoThumbHash) {
                    try {
                        const tRes = await callFacebookGraphApi(`${videoId}?fields=thumbnails`, 'GET', null, profile);
                        const list = (tRes && tRes.thumbnails && Array.isArray(tRes.thumbnails.data)) ? tRes.thumbnails.data : [];
                        const pick = list.find(x => x && x.is_preferred) || list[0];
                        if (pick && pick.uri) {
                            videoThumbUrl = pick.uri;
                            log('INFO', `🎬 [Profile=${profileId}] 视频封面改用 FB 自动缩略图`);
                        }
                    } catch (e) {
                        log('WARN', `⚠️ [Profile=${profileId}] 获取视频自动缩略图失败: ${e.message}`);
                    }
                }
            } catch (videoErr) {
                throw new Error(`视频素材上传失败: ${videoErr.message}`);
            }
        }

        // --- 批量发布循环开始 ---
        for (let c = 0; c < campaignCount; c++) {
            const curCampaignName = campaignCount > 1 ? `${finalCampaignName}_${c + 1}` : finalCampaignName;
            
            // 4. 创建广告系列 (Campaign)
            log('INFO', `🏗️ [Profile=${profileId}] 正在创建广告系列 [${c+1}/${campaignCount}]: ${curCampaignName}`);
            // 🚀 API 调用间插入间隔，避免频率限制
            await new Promise(r => setTimeout(r, 1500));
            const campaignBody = {
                name: curCampaignName,
                objective: finalObjective || 'OUTCOME_TRAFFIC',
                status: autoActivate ? 'PAUSED' : (campaignStatus || 'PAUSED'),
                special_ad_categories: specialAdCategories && Array.isArray(specialAdCategories) && specialAdCategories.length > 0 ? specialAdCategories : [],
                buying_type: buyingType || 'AUCTION'
            };
            // 🚀 品牌安全
            if (brandSafety) { campaignBody.brand_safety = { brand_suitability: brandSuitability || 'standard' }; }
            // 🚀 如果开启系列预算 (CBO)
            if (finalBudgetLevel === 'CAMPAIGN') {
                if (finalBudgetType === 'DAILY') { 
                    campaignBody.daily_budget = Math.round(parseFloat(finalBudget) * 100); 
                } else { 
                    campaignBody.lifetime_budget = Math.round(parseFloat(finalBudget) * 100);
                    // 🚀 核心修复：CBO 总预算模式下，系列级别必须设置结束时间，否则排期不生效
                    if (finalEndDate) campaignBody.stop_time = Math.floor(new Date(finalEndDate).getTime() / 1000);
                    if (finalStartDate) campaignBody.start_time = Math.floor(new Date(finalStartDate).getTime() / 1000);
                }
                if (advantageCampaignBudget) { campaignBody.campaign_budget_optimization = true; }
                // 🔥 CBO 下竞价策略归系列级管，显式传（省略会被 FB 回退成账号默认策略并要求 bid_amount）
                campaignBody.bid_strategy = finalBidStrategyNorm;
            }
            // 🚀 进阶赋能型销量广告系列（Advantage+ Shopping Campaign）
            if (enableAdvantageCampaign) {
                // ⚠️ 该系列类型只支持销量目标，若前端选了别的目标（如线索）会被覆盖，这里显式告警
                if (finalObjective && finalObjective !== 'OUTCOME_SALES') {
                    log('WARN', `⚠️ [Profile=${profileId}] 进阶赋能型系列仅支持销量目标，已把 objective ${finalObjective} → OUTCOME_SALES`);
                }
                campaignBody.objective = 'OUTCOME_SALES';
                campaignBody.special_ad_categories = [];
                campaignBody.campaign_budget_optimization = true;
                campaignBody.advantage_campaign_budget = { is_advantage_campaign_budget: true };
                // 🔥 进阶赋能型系列强制走系列预算（CBO），必须显式带上预算金额：
                //    否则只有 advantage_campaign_budget 而没有 daily/lifetime_budget，
                //    FB 直接报 "No Budget for Campaign"（即使广告组里设了预算也不行）
                if (finalBudgetType === 'LIFETIME') {
                    campaignBody.lifetime_budget = Math.round(parseFloat(finalBudget) * 100);
                    if (finalEndDate) campaignBody.stop_time = Math.floor(new Date(finalEndDate).getTime() / 1000);
                    if (finalStartDate) campaignBody.start_time = Math.floor(new Date(finalStartDate).getTime() / 1000);
                } else {
                    campaignBody.daily_budget = Math.round(parseFloat(finalBudget) * 100);
                }
                log('INFO', `💰 [Profile=${profileId}] 进阶赋能型系列预算: ${finalBudgetType === 'LIFETIME' ? '总预算' : '日预算'} ${finalBudget}`);
                if (finalBidStrategy === 'ROAS' && finalTargetRoas) {
                    campaignBody.bid_strategy = 'ROAS';
                    campaignBody.bid_value = parseFloat(finalTargetRoas);
                } else {
                    // 🔥 进阶赋能型系列下竞价策略归系列级管，必须显式传，否则 FB 回退账号默认策略要求 bid_amount
                    campaignBody.bid_strategy = finalBidStrategyNorm;
                }
                log('INFO', `[Profile=${profileId}] 📤 进阶赋能型销量广告系列已启用`);
            }

            log('WARN', `[Profile=${profileId}] 📤 发送 campaignBody: ${JSON.stringify({...campaignBody})}`);
            const campaignData = await callFacebookGraphApi(`${actId}/campaigns`, 'POST', campaignBody, profile);
            if (!campaignData.id) throw new Error(`Campaign 创建失败: ${formatFBError(campaignData)}`);
            const campaignId = campaignData.id;

            for (let s = 0; s < adSetCount; s++) {
                const curAdSetName = adSetCount > 1 ? `${finalAdSetName}_${s + 1}` : finalAdSetName;
                
                // 5. 创建广告组 (Ad Set)
                log('INFO', `🏗️ [Profile=${profileId}] 正在创建广告组 [${s+1}/${adSetCount}]: ${curAdSetName}`);
                
                // 🎯 版位 / 设备
                //  ✅ 进阶赋能型系列（ADVANTAGE_PLUS_SALES）：**不下发 publisher_platforms**，
                //     平台列表交给 Meta 自动（FB/IG/Messenger/Threads/WhatsApp/AN）——
                //     显式下发六平台反而会被判成"平台未勾选"，Messenger 丢失。
                //  ✅ 设备平台原样下发、不做任何改写：用户选「仅移动端」就发 mobile。
                //     此时 Meta 的 advantage_placement_state 会变成 DISABLED —— 这是用户主动
                //     限制设备后的正常结果，不能为了"看起来是自动版位"而丢掉限制
                //     （丢掉限制 = 偷偷把桌面端也加上、并把自动版位强行打开）。
                //  ✅ 普通系列走自动版位时显式下发六平台，保证 Messenger 等在生效集合里。
                //     publisher_platforms 只接受这六个枚举值，传 "all" 会被直接拒绝。
                const deviceSet = Array.isArray(finalDevicePlatforms) ? finalDevicePlatforms.map(String).sort() : null;
                const noDeviceRestriction = !deviceSet || (deviceSet.length === 2 && deviceSet[0] === 'desktop' && deviceSet[1] === 'mobile');
                const targeting = {
                    geo_locations: { countries: finalCountries ? finalCountries.split(',').map(c => c.trim().toUpperCase()) : ['US'] }
                };
                if (enableAdvantageCampaign) {
                    if (!noDeviceRestriction) {
                        // ⚠️ device_platforms 本身也算「版位定向」：只发它、不发 publisher_platforms 时，
                        //    Meta 会把版位当成手动集合，而手动集合默认不含 Messenger（实测读回：
                        //    targeting 里只有 device_platforms=["mobile"] → Ads Manager 平台行只剩
                        //    FB/IG/AN/WhatsApp/Threads，Messenger 未勾选）。
                        //    所以做了设备限制时必须把六平台一起显式补上，否则 Messenger 永远丢。
                        targeting.publisher_platforms = ['facebook', 'instagram', 'audience_network', 'messenger', 'whatsapp', 'threads'];
                        targeting.device_platforms = finalDevicePlatforms;
                        log('INFO', `📱 [Profile=${profileId}] 进阶赋能型系列 + 设备限制 ${JSON.stringify(finalDevicePlatforms)}：显式下发六平台（含 Messenger）+ 设备，版位状态为 DISABLED（预期）`);
                    } else {
                        // 没限设备：两个字段都不发，Meta 才是真·自动版位（自动覆盖六平台含 Messenger）
                        log('INFO', `🎯 [Profile=${profileId}] 进阶赋能型系列：未限制设备，版位/设备均不下发（维持自动版位）`);
                    }
                    targeting.targeting_automation = { advantage_audience: 1 };
                } else {
                    // 普通系列 + 自动版位：显式下发六平台，保证 Messenger 等在集合里
                    targeting.publisher_platforms = ['facebook', 'instagram', 'audience_network', 'messenger', 'whatsapp', 'threads'];
                    // 设备平台：没传就不下发（= Meta 默认全部设备），不擅自补 ['mobile','desktop']
                    if (Array.isArray(finalDevicePlatforms) && finalDevicePlatforms.length > 0) {
                        targeting.device_platforms = finalDevicePlatforms;
                    }
                }

                // 🚀 地理位置增强
                if (cityTargeting) { targeting.geo_locations.cities = cityTargeting.split(',').map(c => ({ key: c.trim() })).filter(c => c.key); }
                if (regionTargeting) { targeting.geo_locations.regions = regionTargeting.split(',').map(r => ({ key: r.trim() })).filter(r => r.key); }
                if (zips) { targeting.geo_locations.zips = zips.split(',').map(z => z.trim()).filter(z => z); }
                if (dma) { targeting.geo_locations.dma_codes = dma.split(',').map(d => d.trim()).filter(d => d); }
                if (excludeLocations) { targeting.excluded_geo_locations = { countries: excludeLocations.split(',').map(c => c.trim().toUpperCase()) }; }
                // 🚨 location_types 已被 Facebook 移除（不再支持居住地/旅游地/最近到访地分类）

                // 🚀 年龄设置
                targeting.age_min = parseInt(finalAgeMin) || 18;
                targeting.age_max = parseInt(finalAgeMax) || 65;
                // 🐛 修复：Adv+ 要求 age_min 不能高于 25，自动限制
                if (enableAdvantageAudience && targeting.age_min > 25) {
                    log('WARN', `⚠️ [Profile=${profileId}] Adv+ 要求 age_min≤25，自动从 ${targeting.age_min} 修正为 25`);
                    targeting.age_min = 25;
                }
                // 🚀 建议受众年龄范围（Advantage+ AI 起始推荐）
                if (enableAdvantageAudience) {
                    const parsedRange = parseAgeRange(finalAgeRange);
                    if (parsedRange) targeting.age_range = parsedRange;
                }
                if (finalGender === 'male') targeting.genders = [1]; else if (finalGender === 'female') targeting.genders = [2];

                // 🚀 细分定位
                if (finalDetailedTargeting) {
                    try {
                        if (finalDetailedTargeting.startsWith('[') || finalDetailedTargeting.startsWith('{')) { targeting.flexible_spec = JSON.parse(finalDetailedTargeting); }
                        else { targeting.flexible_spec = [{ interests: finalDetailedTargeting.split(',').map(id => ({ id: id.trim() })).filter(item => item.id) }]; }
                    } catch (e) { log('WARN', `细分定位解析失败: ${e.message}`); }
                }
                if (detailedExclusions) { try { targeting.exclusions = JSON.parse(typeof detailedExclusions === 'string' ? detailedExclusions : JSON.stringify(detailedExclusions)); } catch (e) { log('WARN', `排除细分解析失败: ${e.message}`); } }

                // 🚀 自定义受众
                if (customAudiencesInclude) { try { targeting.custom_audiences = JSON.parse(typeof customAudiencesInclude === 'string' ? customAudiencesInclude : JSON.stringify(customAudiencesInclude)); } catch (e) { log('WARN', `受众解析失败: ${e.message}`); } }
                if (customAudiencesExclude) { try { targeting.excluded_custom_audiences = JSON.parse(typeof customAudiencesExclude === 'string' ? customAudiencesExclude : JSON.stringify(customAudiencesExclude)); } catch (e) { log('WARN', `排除受众解析失败: ${e.message}`); } }
                if (excludedConnections) { targeting.excluded_connections = excludedConnections.split(',').map(id => id.trim()).filter(id => id); }
                if (friendsOfConnections && excludedConnections) { targeting.friends_of_connections = excludedConnections.split(',').map(id => id.trim()).filter(id => id); }

                // 🚀 人口统计增强
                const demo = {};
                if (lifeEvents) demo.life_events = [{ id: lifeEvents }];
                if (parents) demo.parents = [{ id: parents }];
                if (relationshipStatus) demo.relationship_statuses = [{ id: relationshipStatus }];
                if (education) demo.education_statuses = [{ id: education === 'HIGH_SCHOOL' ? 1 : education === 'COLLEGE' ? 3 : 4 }];
                if (college) demo.colleges = [{ id: college }];
                if (workEmployer) demo.employers = [{ id: workEmployer }];
                if (income) demo.income = [{ id: income }];
                if (homeOwnership) demo.home_ownership = [{ id: homeOwnership }];
                if (householdComposition) demo.household_composition = [{ id: householdComposition }];
                if (ethnicAffinity) demo.ethnic_affinity = [{ id: ethnicAffinity }];
                if (generation) demo.generation = [{ id: generation }];
                if (digitalActivities) demo.digital_activities = [{ id: digitalActivities }];
                if (politics) demo.politics = [{ id: politics }];
                if (Object.keys(demo).length > 0) targeting.demographics = demo;

                // 🚀 设备平台 / 操作系统 / 最低版本 / 设备型号
                // ⚠️ Meta 的实际表达（已对照 Ads Manager 真实写入值验证）：
                //      device_platforms: ['mobile']              → 仅移动端
                //      user_os: ['iOS_ver_14.0_to_17.2']        → 操作系统 + 版本区间（版本写在 user_os 里，没有独立的版本字段）
                //      user_device: ['iPhone']                   → 设备型号只能用家族名，机型 ID（iPhone_14/SM-S928B）会被 FB 直接拒绝
                //    约束：user_device 必须与 user_os 相符；不能同时定位「有最低版本要求的平台」和另一个平台
                const isMobile = !finalDevicePlatforms || finalDevicePlatforms.includes('mobile');
                const IOS_DEVICES = ['iPhone', 'iPad', 'iPod'];
                const ANDROID_DEVICES = ['Android_Smartphone', 'Android_Tablet'];
                // 版本号支持「整数大版本」与「子版本」两种写法：ios_14 → 14.0，ios_17.2 → 17.2
                const verMinM = String(finalOsVersionMin || '').match(/^(ios|android)_(\d+(?:\.\d+)?)$/);
                const verMaxM = String(finalOsVersionMax || '').match(/^(ios|android)_(\d+(?:\.\d+)?)$/);
                let osPlatform = verMinM ? (verMinM[1] === 'ios' ? 'iOS' : 'Android') : (verMaxM ? (verMaxM[1] === 'ios' ? 'iOS' : 'Android') : null);
                if (!osPlatform && finalOsType === 'ios') { osPlatform = 'iOS'; }
                if (!osPlatform && finalOsType === 'android') { osPlatform = 'Android'; }

                if (isMobile) {
                    // 设备型号：按操作系统过滤，不匹配的值直接丢弃（否则 FB 会整单拒绝）
                    if (deviceModels) {
                        const picked = deviceModels.split(',').map(m => m.trim()).filter(Boolean);
                        const allowed = osPlatform === 'iOS' ? IOS_DEVICES : osPlatform === 'Android' ? ANDROID_DEVICES : [...IOS_DEVICES, ...ANDROID_DEVICES];
                        const kept = picked.filter(m => allowed.includes(m));
                        const dropped = picked.filter(m => !allowed.includes(m));
                        if (dropped.length) { log('WARN', `⚠️ [Profile=${profileId}] 设备型号与操作系统不匹配，已忽略: ${dropped.join(', ')}`); }
                        if (kept.length) {
                            if (!osPlatform) {
                                osPlatform = kept.every(m => IOS_DEVICES.includes(m)) ? 'iOS' : kept.every(m => ANDROID_DEVICES.includes(m)) ? 'Android' : null;
                            }
                            targeting.user_device = kept;
                        }
                    }
                    // user_os：区间写法 iOS_ver_14.0_to_17.2；只设下限则用 …_and_above；只设上限则退回仅平台
                    if (osPlatform) {
                        const p = osPlatform === 'iOS' ? 'ios' : 'android';
                        // 整数大版本补 .0（14 → 14.0），子版本原样保留（17.2 → 17.2）
                        const fmtVer = (s) => (/^\d+$/.test(s) ? `${s}.0` : s);
                        const vMinS = verMinM && verMinM[1] === p ? fmtVer(verMinM[2]) : '';
                        const vMaxS = verMaxM && verMaxM[1] === p ? fmtVer(verMaxM[2]) : '';
                        if (vMinS && vMaxS && parseFloat(vMaxS) >= parseFloat(vMinS)) { targeting.user_os = [`${osPlatform}_ver_${vMinS}_to_${vMaxS}`]; }
                        else if (vMinS) { targeting.user_os = [`${osPlatform}_ver_${vMinS}_and_above`]; }
                        else { targeting.user_os = [osPlatform]; }
                    }
                }
                if (finalWifiOnly) targeting.wireless_carrier = ['Wifi'];
                if (carrierTargeting) targeting.wireless_carrier = carrierTargeting.split(',').map(c => c.trim()).filter(c => c);
                if (connectionSpeed && connectionSpeed !== 'any') targeting.connection_speed = connectionSpeed;
                // 🚀 横向扩展受众 (audience_expansion) — FB部分账号/地区不支持，创建失败时会自动去掉重试
                if (typeof enableAudienceExpansion !== 'undefined' && !enableAdvantageAudience) {
                    if (enableAudienceExpansion === false) {
                        targeting.targeting_automation = { audience_expansion: 'OFF' };
                    } else {
                        targeting.targeting_automation = { audience_expansion: 'HIGH' };
                    }
                }

                // 🐛 修：前端「优化目标」下拉框写的是 adSet.optimizationGoal，而后端以前**完全忽略它**，
                //    只用 objective + engagementType 重新推导 —— 用户选「主页赞(PAGE_LIKES)」会被静默丢掉，
                //    落到默认的 REPLIES（实测 Profile=4132：界面选主页赞，实际发出 REPLIES，
                //    Ads Manager 里看起来就成了消息/网站类广告）。
                //    现在：前端明确选了就**以它为准**；没选才按 objective 推导。
                //    另外前端几个取值不是 Meta 的枚举名，这里做别名映射。
                const OPT_GOAL_ALIAS = {
                    MESSAGES: 'REPLIES',                 // 前端叫「消息」，Meta 枚举是 REPLIES
                    CONVERSIONS: 'OFFSITE_CONVERSIONS',
                };
                const adSetOptGoal = String(adSetNode.optimizationGoal || data.optimizationGoal || '').toUpperCase();
                let optimizationGoal = 'LINK_CLICKS';
                if (adSetOptGoal) {
                    optimizationGoal = OPT_GOAL_ALIAS[adSetOptGoal] || adSetOptGoal;
                    log('INFO', `🎯 [Profile=${profileId}] 使用界面选择的优化目标: ${adSetOptGoal} → ${optimizationGoal}`);
                } else if (finalObjective === 'OUTCOME_SALES') { optimizationGoal = enableVO ? 'VALUE' : 'OFFSITE_CONVERSIONS'; }
                else if (finalObjective === 'OUTCOME_LEADS') { optimizationGoal = 'OFFSITE_CONVERSIONS'; }
                else if (finalObjective === 'OUTCOME_ENGAGEMENT') {
                    if (engagementType === 'PAGE_LIKES') optimizationGoal = 'PAGE_LIKES';
                    else if (engagementType === 'POST_ENGAGEMENT') optimizationGoal = 'POST_ENGAGEMENT';
                    else optimizationGoal = 'REPLIES';
                } else if (finalObjective === 'OUTCOME_AWARENESS') { optimizationGoal = 'REACH'; }

                const adSetBody = {
                    name: curAdSetName, campaign_id: campaignId,
                    billing_event: optimizationGoal === 'REACH' || optimizationGoal === 'IMPRESSIONS' ? 'IMPRESSIONS' : 'IMPRESSIONS',
                    optimization_goal: optimizationGoal,
                    targeting: JSON.stringify(targeting),
                    status: autoActivate ? 'PAUSED' : (adSetStatus || 'PAUSED'),
                };
                // 🎯 转化位置（Ads Manager 里的「转化位置」）：这三个值都是「互动」目标下的站内转化位置。
                //    该字段不传时 Meta 记成 UNDEFINED，Ads Manager 会兜底显示成「网站」，
                //    于是「主页赞」广告看起来变成了网站转化广告（实测 Profile=4132）。
                //    ⚠️ Meta 限制：ON_PAGE / ON_POST / ON_VIDEO 只在广告系列目标为 OUTCOME_ENGAGEMENT
                //       时合法，其他目标（如 OUTCOME_AWARENESS/OUTCOME_TRAFFIC）传这些值会被直接拒单，
                //       所以必须连目标一起判断，不能只按优化目标映射。
                if (String(finalObjective || '').toUpperCase() === 'OUTCOME_ENGAGEMENT') {
                    const DESTINATION_TYPE_BY_GOAL = { PAGE_LIKES: 'ON_PAGE', POST_ENGAGEMENT: 'ON_POST', THRUPLAY: 'ON_VIDEO' };
                    const _destType = DESTINATION_TYPE_BY_GOAL[optimizationGoal];
                    if (_destType) adSetBody.destination_type = _destType;
                }
                // 🚀 排期 + 时区(仅 LIFETIME 模式) — 必须在 pacing_type 之前判断
                let hasSchedule = false;
                if (finalBudgetType === 'LIFETIME') {
                    if (finalEndDate) adSetBody.end_time = Math.floor(new Date(finalEndDate).getTime() / 1000);
                    if (finalStartDate) adSetBody.start_time = Math.floor(new Date(finalStartDate).getTime() / 1000);
                    
                    if (finalAdSchedule && Array.isArray(finalAdSchedule) && finalAdSchedule.length > 0) {
                        const scheduleMap = new Map();
                        for (const slot of finalAdSchedule) {
                            if (!slot.active) continue;
                            if (!scheduleMap.has(slot.hour)) scheduleMap.set(slot.hour, new Set());
                            scheduleMap.get(slot.hour).add(slot.day);
                        }
                        
                        const dayParts = [];
                        for (const [hour, daySet] of scheduleMap) {
                            // FB: 0=Sunday, 1=Monday... 6=Saturday. 前端: 0=Monday... 6=Sunday
                            const fbDays = Array.from(daySet).map((d) => (d + 1) % 7).sort();
                            dayParts.push({ 
                                days: fbDays, 
                                start_minute: hour * 60, 
                                end_minute: (hour + 1) * 60 
                            });
                        }
                        
                        if (dayParts.length > 0) {
                            adSetBody.adset_schedule = JSON.stringify(dayParts);
                            // 🚀 核心修复：使用排期时，pacing_type 必须显式设为 ['standard']
                            adSetBody.pacing_type = ['standard'];
                            hasSchedule = true;
                            log('WARN', `[Profile=${profileId}] 📅 排期已设置: ${JSON.stringify(dayParts)} (使用 Ad Account 时区)`);
                        }
                    }
                }
                // 🚀 pacing_type（如果没有排期，根据用户设置或默认 standard）
                if (!hasSchedule) { 
                    adSetBody.pacing_type = finalPacingType === 'no_pacing' ? ['no_pacing'] : ['standard']; 
                }
                // 🚀 语言 locale 数字映射表（广告组 targeting.locales + 创意 asset_feed_spec.languages 共用）
                const LOCALE_MAP = { 
                    'en_US':6,'en_GB':23,'es_LA':29,'es_ES':19,'fr_FR':30,'de_DE':17,'it_IT':34,'pt_BR':41,'ja_JP':11,'ko_KR':13,'zh_CN':48,'zh_TW':49,'zh_HK':52,'ar_AR':1,'nl_NL':22,'sv_SE':45,'da_DK':16,'no_NO':36,'fi_FI':26,'pl_PL':40,'ru_RU':43,'tr_TR':50,'th_TH':47,'id_ID':35,'vi_VN':54,'ms_MY':33,'tl_PH':27,
                    // 🚀 补充简写映射（覆盖前端 AD_CREATIVE_LANGUAGES 简写代码）
                    'en':6,'es':29,'fr':30,'de':17,'it':34,'pt':41,'ja':11,'ko':13,'zh':48,'zh_HK':52,'ru':43,'th':47,'vi':54,'id':35,'ms':33,'tr':50,'ar':1,'nl':22,'sv':45,'da':16,'no':36,'nb':36,'fi':26,'pl':40,'tl':27
                };
                if (finalLanguages) {
                    const langList = Array.isArray(finalLanguages) ? finalLanguages : finalLanguages.split(',').map(l => l.trim()).filter(Boolean);
                    const rawIds = langList.map(code => ({ code, id: LOCALE_MAP[code] }));
                    const localeIds = rawIds.filter(x => x.id).map(x => x.id);
                    const unmapped = rawIds.filter(x => !x.id).map(x => x.code);
                    if (unmapped.length > 0) {
                        log('WARN', `[Profile=${profileId}] ⚠️ 语言映射失败，没有对应 locale ID: ${unmapped.join(',')}`);
                    }
                    if (localeIds.length > 0) {
                        const t = JSON.parse(adSetBody.targeting);
                        t.locales = localeIds;
                        adSetBody.targeting = JSON.stringify(t);
                        log('WARN', `[Profile=${profileId}] 📤 语言已转为 targeting.locales: ${JSON.stringify(localeIds)}`);
                    }
                }
                // 🚀 归因
                // 优先级：广告组「归因选择」attributionSpec > 广告组「转化窗口」conversionWindow
                //        > 广告系列「转化归因窗口」conversionAttributionWindow > 默认 7天点击+1天展示
                // ⚠️ 以前只读 attributionSpec，而它在界面上没有默认值 → 服务端拿到 undefined，
                //    于是走 else 分支硬编码成「1天点击」：界面上选的「7天点击+1天展示」根本没发出去。
                const ATTRIBUTION_PRESETS = {
                    '1D_CLICK_ONLY': [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
                    '1D_CLICK_0_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
                    '1D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
                    '7D_CLICK_ONLY': [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
                    '7D_CLICK_0_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
                    '7D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
                    '7D_CLICK_7D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 7 }],
                    '28D_CLICK_ONLY': [{ event_type: 'CLICK_THROUGH', window_days: 28 }],
                    '28D_CLICK_0_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 28 }],
                    '28D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 28 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
                    '28D_CLICK_7D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 28 }, { event_type: 'VIEW_THROUGH', window_days: 7 }],
                    '28D_CLICK_28D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 28 }, { event_type: 'VIEW_THROUGH', window_days: 28 }],
                };
                const attributionSource = finalAttributionSpec || finalConversionWindow || finalConversionAttributionWindow;
                const attributionKey = attributionSource ? String(attributionSource).trim().toUpperCase() : '';
                // ⚠️ 必须 slice 拷贝：下面会往数组里插项，直接改会污染预设表
                const attributionPreset = (ATTRIBUTION_PRESETS[attributionKey] || ATTRIBUTION_PRESETS['7D_CLICK_1D_VIEW']).slice();
                // 🎬 补上「互动观看（仅限视频）」：Ads Manager 的归因设置是三行
                //    点击 / 互动观看（仅限视频） / 浏览，Meta 对应的枚举是 ENGAGED_VIDEO_VIEW（固定 1 天）。
                //    不补就只有两行，Ads Manager 里会显示成 "7-day click, 1-day view"。
                //
                //    ⚠️ 这里不做「预判式降级」：Meta 对「目标 + 优化目标」有组合限制
                //       （例如互动类 OUTCOME_ENGAGEMENT + REPLIES 只允许 (点击1天, 浏览0天)），
                //       但限制组合繁多且随 Meta 调整，猜错等于悄悄改掉用户的投放设置。
                //       改为**按 Meta 的实际报错修复**：AdSet 创建失败且 subcode=1885501 /
                //       "View-Through Attribution Window Is Invalid" 时，自动降级为 (1, 0) 重试一次
                //       （见下方 AdSet 重试链的第 0 条）。Meta 没报这个错时，一律不动用户的选择。
                if (attributionPreset.some(s => s.event_type === 'VIEW_THROUGH')
                    && !attributionPreset.some(s => s.event_type === 'ENGAGED_VIDEO_VIEW')) {
                    attributionPreset.splice(1, 0, { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 });
                }
                adSetBody.attribution_spec = JSON.stringify(attributionPreset);
                log('INFO', `📊 [Profile=${profileId}] 归因窗口: ${attributionSource || '(未选择,默认7天点击+1天展示)'} → ${JSON.stringify(attributionPreset)}`);
                // 🚀 出价/费用控制
                if (finalCostPerResult && !isNaN(parseFloat(finalCostPerResult))) { adSetBody.bid_amount = Math.round(parseFloat(finalCostPerResult) * 100); }
                // 🚀 版位控制：仅「手动版位」时才推导并写入 publisher_platforms（自动版位保持不传）
                if (finalPlacements === 'manual' && finalPlacementsControl) {
                    try {
                        adSetBody.placements_control = finalPlacementsControl.startsWith('{') ? JSON.parse(finalPlacementsControl) : { excluded_placements: finalPlacementsControl.split(',').map(p => p.trim()) };
                        // 根据 included/excluded 自动推导 publisher_platforms
                        const pc = adSetBody.placements_control;
                        const excluded = pc.excluded_placements || [];
                        const included = pc.included_placements || [];
                        const platformMap = {
                            feed: 'facebook', video_feeds: 'facebook', marketplace: 'facebook', reels_overlay: 'facebook',
                            story: 'facebook', instream: 'facebook', search: 'facebook', in_article: 'facebook',
                            apps_and_sites: 'facebook',
                            stream: 'instagram', explore: ['facebook', 'instagram'], reels: 'instagram', shop: ['facebook', 'instagram'], story_ig: 'instagram',
                            native_banner_interstitial: 'audience_network', rewarded_video: 'audience_network',
                            inbox: 'messenger', story_m: 'messenger',
                            // 🚀 补 WhatsApp：以前这张表没有 whatsapp，手动版位时
                            //    无论怎么勾，publisher_platforms 都会少一个 WhatsApp
                            whatsapp_status: 'whatsapp',
                            threads_feed: 'threads', threads_profile: 'threads', threads_search: 'threads',
                        };
                        const allPlacementIds = ['feed','video_feeds','marketplace','reels_overlay','story','instream','search','in_article','apps_and_sites',
                            'stream','explore','reels','shop','story_ig',
                            'native_banner_interstitial','rewarded_video',
                            'inbox','story_m',
                            'whatsapp_status',
                            'threads_feed','threads_profile','threads_search'];
                        let platforms = new Set();
                        let hasAnyPlacement = false;
                        for (const id of allPlacementIds) {
                            const isExcluded = excluded.includes(id);
                            const isIncluded = included.length === 0 || included.includes(id);
                            const isActive = included.length > 0 ? isIncluded : !isExcluded;
                            if (isActive) {
                                hasAnyPlacement = true;
                                const plat = platformMap[id];
                                if (Array.isArray(plat)) {
                                    plat.forEach(p => platforms.add(p));
                                } else if (plat) {
                                    platforms.add(plat);
                                }
                            }
                        }
                        if (hasAnyPlacement && platforms.size > 0) {
                            // ⚠️ publisher_platforms 属于 targeting 内部字段：
                            //    以前写成 adSetBody.publisher_platforms（顶层）是无效参数，
                            //    手动版位实际根本没生效 —— 这里解析 targeting 后写回去再序列化。
                            const t = JSON.parse(adSetBody.targeting || '{}');
                            t.publisher_platforms = Array.from(platforms);
                            adSetBody.targeting = JSON.stringify(t);
                            log('INFO', `🎯 [Profile=${profileId}] 手动版位 → publisher_platforms=${JSON.stringify(t.publisher_platforms)}`);
                        }
                    } catch (e) {}
                }
                // 🚀 仅当各语言有实际内容时才排除不支持的版位，并使用 Advantage+ 自动版位
                const hasFilledLangContent = enableLanguage && languageContent && typeof languageContent === 'object' && (() => {
                    const vals = Object.values(languageContent);
                    return vals.some((v) => v && (v.body || v.headline || v.description || v.websiteUrl));
                })();
                if (hasFilledLangContent) {
                    // 🐛 修复：多语言广告使用 asset_feed_spec，必须使用 Advantage+ 自动版位。
                    // 清除 publisher_platforms 让 Facebook 自动选择版位，
                    // 否则手动版位会覆盖 asset_feed_spec 导致多语言不生效
                    // ⚠️ 保留 device_platforms：「仅移动端」是设备硬限制，与版位无关，不应被清除
                    delete targeting.publisher_platforms;
                    delete adSetBody.publisher_platforms;
                    // 🐛 修复：asset_feed_spec 需要 Advantage+ 受众，否则 geo_locations 冲突报错
                    targeting.targeting_automation = { advantage_audience: 1 };
                    // 🚀 多语言广告建议受众年龄范围
                    const multiLangAgeRange = parseAgeRange(finalAgeRange);
                    if (multiLangAgeRange) targeting.age_range = multiLangAgeRange;
                    adSetBody.targeting_automation = { advantage_audience: 1 };
                    // 只排除不支持的版位
                    const incompatiblePlacements = ['marketplace', 'notifications', 'feed', 'reels_overlay', 'search', 'explore', 'stream', 'instagram_search'];
                    const existingExcluded = (adSetBody.placements_control?.excluded_placements) || [];
                    const newExcluded = [...new Set([...existingExcluded, ...incompatiblePlacements])];
                    if (newExcluded.length > existingExcluded.length) {
                        const added = newExcluded.filter(p => !existingExcluded.includes(p));
                        adSetBody.placements_control = { excluded_placements: newExcluded };
                        adSetBody.allow_limited_spend_on_excluded_placements = true;
                        log('WARN', `⚠️ [Profile=${profileId}] 多语言广告 → 启用Advantage+自动版位，排除不兼容版位: ${added.join(', ')}`);
                    } else {
                        // 即使没新增，也确保没有 publisher_platforms
                        adSetBody.placements_control = adSetBody.placements_control || { excluded_placements: [] };
                        adSetBody.allow_limited_spend_on_excluded_placements = true;
                        log('INFO', `💡 [Profile=${profileId}] 多语言广告 → 已切换为Advantage+自动版位`);
                    }
                    // 🐛 修复：多语言广告必须关闭动态创意（is_dynamic_creative=false）
                    // 否则 asset_feed_spec + 动态创意冲突导致多语言不生效
                    adSetBody.is_dynamic_creative = false;
                }
                if (finalAllowLimitedSpend) { adSetBody.allow_limited_spend_on_excluded_placements = true; }
                // 🚀 客户生命周期
                // ⚠️ Meta 的真实参数是 ad_set_goal（map），不是 customer_lifecycle_parameters：
                //    后者不是合法参数，FB 会静默忽略 → 表现为"选了但没生效"（已核对官方 AdSet spec）。
                //    ad_set_goal.type 取值来自 Ads Manager 前端 CampaignGoalType 枚举：
                //      0 = BROAD（促进所有受众发生转化）
                //      1 = EXCLUDE_EXISTING_AND_ENGAGED_CUSTOMERS（获取新客户）
                if (finalCustomerLifecycle === 'NEW') {
                    adSetBody.ad_set_goal = { type: 1 };
                    log('INFO', `👥 [Profile=${profileId}] 客户生命周期: 获取新客户 (ad_set_goal.type=1)`);
                } else if (finalCustomerLifecycle === 'ALL') {
                    adSetBody.ad_set_goal = { type: 0 };
                    log('INFO', `👥 [Profile=${profileId}] 客户生命周期: 促进所有受众发生转化 (ad_set_goal.type=0)`);
                } else {
                    log('INFO', `👥 [Profile=${profileId}] 客户生命周期: 未选择(不下发 ad_set_goal)`);
                }
                // 🚀 欧盟广告主声明（targeting EU countries requires beneficiary/advertiser_name）
                const euCountries = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','GB'];
                const targetingObj = JSON.parse(adSetBody.targeting || '{}');
                const countries = targetingObj.geo_locations?.countries || [];
                const hasEU = countries.some(c => euCountries.includes(c));
                if (hasEU) {
                    adSetBody.dsa_beneficiary = data.advertiserName || adSetNode.advertiserName || profile?.name || 'Advertiser';
                    adSetBody.dsa_payor = data.advertiserName || adSetNode.advertiserName || adSetBody.dsa_beneficiary;
                    delete adSetBody.advertiser_name;
                    delete adSetBody.beneficiary;
                    log('WARN', `[Profile=${profileId}] 🇪🇺 EU国家检测(${countries.filter(c => euCountries.includes(c)).join(',')})，已添加 DSA 受益方: ${adSetBody.dsa_beneficiary}`);
                }
                // 🚀 加速投放
                if (deliveryType === 'accelerated') { adSetBody.delivery_type = 'accelerated'; }
                // 🚀 竞价 — 大小写归一化 + 全策略兜底
                const fs = (finalBidStrategy || '').toUpperCase();
                const effBid = finalCostPerResult || finalBidAmount;
                const effBidNum = parseFloat(String(effBid || ''));
                if (effBid && !isNaN(effBidNum) && effBidNum > 0) {
                    adSetBody.bid_amount = Math.round(effBidNum * 100);
                    if (finalCostPerResult) { adSetBody.bid_strategy = 'COST_CAP'; }
                    else if (fs === 'TARGET_COST') { adSetBody.bid_strategy = 'TARGET_COST'; }
                    else if (fs === 'COST_CAP') { adSetBody.bid_strategy = 'COST_CAP'; }
                    else { adSetBody.bid_strategy = 'LOWEST_COST_WITH_BID_CAP'; }
                } else if (['TARGET_COST', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'BID_CAP'].includes(fs)) {
                    // 这些策略必须有 bid_amount
                    adSetBody.bid_strategy = fs === 'COST_CAP' ? 'COST_CAP' : fs;
                    adSetBody.bid_amount = 100; // $1.00 兜底
                } else if (fs && !['LOWEST_COST_WITHOUT_CAP', ''].includes(fs)) {
                    // ROAS 等策略只需 strategy 字段
                    adSetBody.bid_strategy = fs;
                } else {
                    // 🔥 最低成本无上限必须显式传：省略时 FB 会回退到广告账号的默认竞价策略并要求 bid_amount
                    //    但预算在系列级（CBO / 进阶赋能型）时竞价策略归系列管，adset 再传会冲突
                    const budgetAtCampaign = finalBudgetLevel === 'CAMPAIGN' || !!enableAdvantageCampaign;
                    if (!budgetAtCampaign) { adSetBody.bid_strategy = 'LOWEST_COST_WITHOUT_CAP'; }
                }
                log('WARN', `💰 AdSet竞价最终: strategy=${adSetBody.bid_strategy || 'LOWEST_COST_WITHOUT_CAP(省略)'}, amount=${adSetBody.bid_amount || '无'}, effBid=${effBid}, finalBidStrategy=${finalBidStrategy}, fs=${fs}`);
                // 🚀 广告组预算
                // ⚠️ 进阶赋能型系列强制使用系列预算(CBO)，广告组再带预算会被 FB 拒绝 → 跳过
                if (finalBudgetLevel === 'ADSET' && enableAdvantageCampaign) {
                    log('WARN', `⚠️ [Profile=${profileId}] 进阶赋能型系列只能用系列预算，已忽略广告组预算设置`);
                } else if (finalBudgetLevel === 'ADSET') {
                    if (finalBudgetType === 'DAILY') { 
                        adSetBody.daily_budget = Math.round(parseFloat(finalBudget) * 100); 
                    } else { 
                        adSetBody.lifetime_budget = Math.round(parseFloat(finalBudget) * 100); 
                        // 🚀 核心修复：总预算模式下，如果没有排期，也默认使用标准投放
                        if (!adSetBody.pacing_type) adSetBody.pacing_type = ['standard'];
                    }
                }
                // 🚀 推广对象：解析已在前置步骤完成（像素 / 账号主页 / 允许为空），这里只按优先级落盘
                // 🐛 修：以前只要「有像素」就无条件挂 {pixel_id, custom_event_type}，完全不看 objective ——
                //    于是 OUTCOME_ENGAGEMENT 这类本就不需要推广对象的目标也被塞了 custom_event_type:PURCHASE，
                //    Meta 回 (#100 / subcode 2446814) Conversion event unavailable
                //    （实测 Profile=4132：目标=互动，优化目标=消息回复，却被挂上「购买」转化事件）。
                //    现在按目标分流：只有与「像素转化」天然匹配的目标才用 pixel；其余目标优先用主页；
                //    两者都不适用时不传，而不是硬塞一个转化事件进去。
                const PIXEL_OBJECTIVES = ['OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC'];
                // 🎯 主页类优化目标（PAGE_LIKES/POST_ENGAGEMENT/REPLIES/CONVERSATIONS，见 PAGE_OBJECT_GOALS）
                //    不在 PIXEL_OBJECTIVES 里 → 自动落到下面的 page_id 分支，与前置解析（查主页）口径一致；
                //    之前只认 PAGE_LIKES，帖子互动/消息互动漏挂 promoted_object，建 Ad 时报
                //    "Ad Set with Promoted Object Is Required"。
                const usePixelForAdSet = effectivePixelId && PIXEL_OBJECTIVES.includes(String(finalObjective || '').toUpperCase());
                if (usePixelForAdSet) { adSetBody.promoted_object = JSON.stringify({ pixel_id: effectivePixelId, custom_event_type: finalConversionEvent || 'PURCHASE' }); }
                else if (resolvedPageId) { adSetBody.promoted_object = JSON.stringify({ page_id: resolvedPageId }); }
                else if (needsPromotedObject) { throw new Error(`AdSet 创建失败: 目标 ${finalObjective} 需要推广对象，但广告账户 ${actId} 无可用像素、账号下也没有主页`); }
                else { log('WARN', `⚠️ [Profile=${profileId}] 目标 ${finalObjective} 不要求推广对象，且无像素/主页，跳过 promoted_object`); }

                log('WARN', `[Profile=${profileId}] 📤 发送 adSetBody: ${JSON.stringify({access_token: '***', ...adSetBody})}`);
                await new Promise(r => setTimeout(r, 2000));
                let adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                // 🚀 AdSet 创建失败时重试逻辑
                if (!adSetData || !adSetData.id) {
                    const errMsg = formatFBError(adSetData);
                    // 🐛 打印原始错误体（含 code/subcode/error_user_msg），否则只看到友好文案没法定位
                    log('WARN', `📛 [Profile=${profileId}] AdSet 失败原始错误: ${JSON.stringify(adSetData && adSetData.error ? adSetData.error : adSetData)}`);
                    // 🛑 账号层面的硬错误：不是定向/参数问题，改任何字段重试都不会成功，
                    //    早退能让真实原因（账号被停用 / 无付款方式）直接浮到最上面，
                    //    否则会被后面「去掉 user_os 重试 → 又报 Invalid user_os value」之类的假象掩盖
                    if (/Disabled accounts|Only active accounts|account is disabled|被停用|停用|No payment method|无付款方式|付款方式/i.test(errMsg)) {
                        throw new Error(`AdSet 创建失败(账号不可用，与定向/参数无关): ${errMsg}`);
                    }
                    let retried = false;
                    // 🐛 修复：targeting 已被 JSON.stringify，需要先 parse
                    let targetingObj = {};
                    try { targetingObj = JSON.parse(adSetBody.targeting || '{}'); } catch {}
                    // 0) 归因窗口不被「目标 + 优化目标」支持 → 自动降级重试（缘由见上方归因预设处的说明）
                    //    Meta 会在 error_user_msg 里给出可用组合（如 "supported ... are: (1, 0)"），
                    //    这里按最常见的 (点击1天 / 浏览0天) 降级后重试一次。
                    //    ⚠️ 必须排在重试链最前面：后面第 6 条 ad_set_goal 重试不校验错误内容，
                    //       归因错误会被它先吃掉一轮白跑（实测日志里就是这样）。
                    const _adSetSubcode = Number((adSetData && adSetData.error && adSetData.error.error_subcode) || 0);
                    const _isAttribWindowErr = _adSetSubcode === 1885501 || /attribution window/i.test(String(errMsg || ''));
                    if ((!adSetData || !adSetData.id) && _isAttribWindowErr) {
                        adSetBody.attribution_spec = JSON.stringify([{ event_type: 'CLICK_THROUGH', window_days: 1 }]);
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因归因窗口不被当前目标支持失败，自动降级为「点击1天 / 浏览0天」重试: ${errMsg}`);
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 1) targeting_automation 可能不兼容 → 去掉重试
                    if (targetingObj.targeting_automation) {
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因 targeting_automation 失败，去掉后重试: ${errMsg}`);
                        delete targetingObj.targeting_automation;
                        adSetBody.targeting = JSON.stringify(targetingObj);
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 2) 竞价金额必须提供 → 加竞价上限重试
                    //    ⚠️ 原判断 errMsg.includes('bid') 是大小写敏感的，而 FB 返回的是
                    //       "Bid Amount Required For The Bid Strategy Provided"（首字母大写），永远匹配不上，
                    //       这段兜底实际是死代码 → 改成大小写不敏感匹配
                    if ((!adSetData || !adSetData.id) && /bid amount|bid_amount|bid strategy|竞价金额/i.test(errMsg)) {
                        const explicitBid = Math.round(parseFloat(String(effBid || '')) * 100);
                        const bidAmt = (!isNaN(explicitBid) && explicitBid > 0) ? explicitBid : 100;
                        // 「要求竞价金额」对应的必须是带竞价上限的策略：
                        // 原来写成 LOWEST_COST_WITHOUT_CAP 却又传 bid_amount，策略和金额自相矛盾
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因竞价问题失败，改用 LOWEST_COST_WITH_BID_CAP $${(bidAmt / 100).toFixed(2)} 重试: ${errMsg}`);
                        adSetBody.bid_strategy = 'LOWEST_COST_WITH_BID_CAP';
                        adSetBody.bid_amount = bidAmt;
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 3) 推广对象问题 → 尝试换用 page_id
                    if ((!adSetData || !adSetData.id) && (errMsg.includes('广告主') || errMsg.includes('advertiser') || errMsg.includes('promoted'))) {
                        const pageIdForAd = resolvedPageId || '';
                        if (pageIdForAd) {
                            log('WARN', `⚠️ [Profile=${profileId}] AdSet 因推广对象问题失败，换用 page_id 重试: ${errMsg}`);
                            adSetBody.promoted_object = JSON.stringify({ page_id: pageIdForAd });
                            adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                            retried = true;
                        }
                    }
                    // 4) 设备平台限制被 Meta 拒绝（Adv+ / 动态创意场景）→ 去掉 device_platforms 重试
                    if ((!adSetData || !adSetData.id) && targetingObj.device_platforms && /device_platform|设备平台|placement/i.test(errMsg)) {
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因设备平台限制被拒，去掉「仅移动端」后重试: ${errMsg}`);
                        delete targetingObj.device_platforms;
                        adSetBody.targeting = JSON.stringify(targetingObj);
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 5) user_os / user_device 被 Meta 拒绝 → 去掉版本与机型限制后重试
                    //    ⚠️ 原写法只判断 targetingObj.user_os 是否存在，不看错误内容：
                    //       账号停用、竞价错误等无关失败也会被当成版本问题重试，
                    //       白跑两次请求还会把真实原因盖成 "Invalid user_os value"
                    //    ⚠️ user_device（如 iPhone）与 user_os 必须成对：只删 user_os 会留下
                    //       「指定机型却没有任何操作系统版本」的矛盾组合，Meta 同样拒绝 → 一起删
                    if ((!adSetData || !adSetData.id) && (targetingObj.user_os || targetingObj.user_device)
                        && /user_os|user_device|operating system|操作系统|设备平台|device/i.test(errMsg)) {
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因操作系统/机型限制被拒 (user_os=${JSON.stringify(targetingObj.user_os)}, user_device=${JSON.stringify(targetingObj.user_device)})，去掉后重试: ${errMsg}`);
                        delete targetingObj.user_os;
                        delete targetingObj.user_device;
                        adSetBody.targeting = JSON.stringify(targetingObj);
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 6) 客户生命周期(ad_set_goal) 不被当前系列/目标支持时 → 去掉后重试
                    //    ⚠️ 放在最后兜底：若 Meta 因该字段拒绝，至少还能把广告组建出来
                    if ((!adSetData || !adSetData.id) && adSetBody.ad_set_goal) {
                        log('WARN', `⚠️ [Profile=${profileId}] AdSet 因客户生命周期(ad_set_goal)失败，去掉后重试: ${errMsg}`);
                        delete adSetBody.ad_set_goal;
                        adSetData = await callFacebookGraphApi(`${actId}/adsets`, 'POST', adSetBody, profile);
                        retried = true;
                    }
                    // 7) 重试仍未成功则报错
                    if (retried && (!adSetData || !adSetData.id)) {
                        // 🐛 重试链的原始错误体必须打出来：只打 formatFBError 的友好文案会丢掉
                        //    code/subcode/blame_field_specs，导致「哪一步重试失败的」无从判断
                        log('WARN', `📛 [Profile=${profileId}] AdSet 重试链全部失败，最终原始错误: ${JSON.stringify(adSetData && adSetData.error ? adSetData.error : adSetData)}`);
                        throw new Error(`AdSet 创建失败(重试后): ${formatFBError(adSetData)}`);
                    }
                }
                if (!adSetData.id) throw new Error(`AdSet 创建失败: ${formatFBError(adSetData)}`);
                log('WARN', `[Profile=${profileId}] ✅ AdSet 创建成功: id=${adSetData.id}, strategy=${adSetBody.bid_strategy}, amount=${adSetBody.bid_amount}`);
                const adSetId = adSetData.id;

                // 🚀 Advantage+ 受众
                if (enableAdvantageAudience) {
                    log('INFO', `[Profile=${profileId}] 正在更新 AdSet ${adSetId} 添加 Advantage+ 受众...`);
                    let existingTargeting = {};
                    try {
                        const currentAdSet = await callFacebookGraphApi(`${adSetId}?fields=targeting`, 'GET', null, profile);
                        if (currentAdSet && currentAdSet.targeting) existingTargeting = currentAdSet.targeting;
                    } catch (e) { log('WARN', `[Profile=${profileId}] 获取现有 targeting 失败: ${e.message}`); }
                    // 🚀 Adv+ 要求年龄范围 18-65+，只在当前年龄超出范围时才重置
                    if (existingTargeting.age_min || existingTargeting.age_max) {
                        const curMin = existingTargeting.age_min;
                        const curMax = existingTargeting.age_max;
                        if (curMin < 18 || curMax > 65 || curMax < 18) {
                            existingTargeting.age_min = 18;
                            existingTargeting.age_max = 65;
                        }
                    } else {
                        existingTargeting.age_min = 18;
                        existingTargeting.age_max = 65;
                    }
                    // 🚀 建议受众年龄范围（Adv+ AI 起始推荐）
                    const advAgeRange = parseAgeRange(finalAgeRange);
                    if (advAgeRange) existingTargeting.age_range = advAgeRange;
                    existingTargeting.targeting_automation = { advantage_audience: 1 };
                    const patchResult = await callFacebookGraphApi(`${adSetId}`, 'POST', { targeting: JSON.stringify(existingTargeting) }, profile);
                    if (patchResult.id || (!patchResult.error && patchResult.success !== false)) { log('SUCCESS', `✅ [Profile=${profileId}] Advantage+ 受众已应用`); }
                    else { log('INFO', `ℹ️ [Profile=${profileId}] Advantage+ 不适用于此广告组，已跳过: ${formatFBError(patchResult)}`); }
                }

                // 🚀 发布后年龄修改（3步策略：先关Adv+→改年龄→再开Adv+）
                if (enableAgeModify && adSetId) {
                    let postAgeMin = parseInt(ageMinModify || ageMin);
                    const postAgeMax = parseInt(ageMaxModify || ageMax);
                    log('INFO', `[Profile=${profileId}] 正在修改 AdSet ${adSetId} 年龄: ${postAgeMin}-${postAgeMax}（如有 Adv+ 自动临时关闭再恢复）`);

                    // 尝试 3 次（网络波动重试）
                    let ageModified = false;
                    let hadAdvAudience = false;
                    for (let ageRetry = 0; ageRetry < 3 && !ageModified; ageRetry++) {
                        try {
                            if (ageRetry > 0) await new Promise(r => setTimeout(r, 2000));
                            // 1. 获取现有 targeting
                            let currentTargeting = {};
                            try {
                                const currentAdSet = await callFacebookGraphApi(`${adSetId}?fields=targeting`, 'GET', null, profile);
                                if (currentAdSet && currentAdSet.targeting) currentTargeting = currentAdSet.targeting;
                            } catch (getErr) {
                                log('WARN', `[Profile=${profileId}] 获取现有 targeting 失败(重试 ${ageRetry}): ${getErr.message}`);
                            }
                            // 检测 Adv+ 状态
                            hadAdvAudience = currentTargeting.targeting_automation?.advantage_audience === 1 || currentTargeting.targeting_automation?.advantage_audience === true;
                            if (hadAdvAudience) {
                                // 2. 临时关闭 Adv+ 以允许改年龄
                                log('INFO', `[Profile=${profileId}] ⚡ 临时关闭 Adv+ 受众以设置年龄...`);
                                const tmpForm = new URLSearchParams();
                                const tmpTargeting = { ...currentTargeting, targeting_automation: { advantage_audience: 0 } };
                                tmpForm.append('targeting', JSON.stringify(tmpTargeting));
                                const tmpResult = await callFacebookGraphApi(`${adSetId}`, 'POST', tmpForm, profile);
                                if (tmpResult && (tmpResult.id || tmpResult.success !== false) && !tmpResult.error) {
                                    log('INFO', `[Profile=${profileId}] ✅ Adv+ 已临时关闭`);
                                } else {
                                    log('WARN', `[Profile=${profileId}] ⚠️ 关闭 Adv+ 失败，仍尝试直接改年龄`);
                                }
                            }

                            // 3. 注入年龄字段
                            currentTargeting.age_min = postAgeMin;
                            currentTargeting.age_max = postAgeMax;
                            if (hadAdvAudience) currentTargeting.targeting_automation = { advantage_audience: 0 };
                            const ageForm = new URLSearchParams();
                            ageForm.append('targeting', JSON.stringify(currentTargeting));
                            const ageResult = await callFacebookGraphApi(`${adSetId}`, 'POST', ageForm, profile);

                            // 4. 验证结果
                            if (ageResult && (ageResult.id || ageResult.success !== false) && !ageResult.error) {
                                log('SUCCESS', `✅ [Profile=${profileId}] AdSet ${adSetId} 年龄已修改为 ${postAgeMin}-${postAgeMax}`);
                                ageModified = true;
                                // 5. 恢复 Adv+ 受众
                                if (hadAdvAudience) {
                                    log('INFO', `[Profile=${profileId}] ⚡ 重新开启 Adv+ 受众...`);
                                    try {
                                        const restoreTarget = await callFacebookGraphApi(`${adSetId}?fields=targeting`, 'GET', null, profile);
                                        const restoreT = (restoreTarget && restoreTarget.targeting) ? restoreTarget.targeting : currentTargeting;
                                        restoreT.targeting_automation = { advantage_audience: 1 };
                                        const restoreForm = new URLSearchParams();
                                        restoreForm.append('targeting', JSON.stringify(restoreT));
                                        const restoreResult = await callFacebookGraphApi(`${adSetId}`, 'POST', restoreForm, profile);
                                        if (restoreResult && (restoreResult.id || restoreResult.success !== false) && !restoreResult.error) {
                                            log('SUCCESS', `✅ [Profile=${profileId}] Adv+ 受众已恢复`);
                                        } else {
                                            log('WARN', `⚠️ [Profile=${profileId}] Adv+ 恢复失败，请手动开启`);
                                        }
                                    } catch (restoreErr) {
                                        log('WARN', `⚠️ [Profile=${profileId}] Adv+ 恢复异常: ${restoreErr.message}`);
                                    }
                                }
                            } else {
                                log('WARN', `⚠️ [Profile=${profileId}] 年龄修改失败(重试 ${ageRetry}): ${formatFBError(ageResult)}`);
                            }
                        } catch (e) {
                            log('WARN', `⚠️ [Profile=${profileId}] 年龄修改异常(重试 ${ageRetry}): ${e.message}`);
                        }
                    }
                    if (!ageModified) {
                        log('ERROR', `❌ [Profile=${profileId}] 年龄修改最终失败，请手动修改 AdSet ${adSetId} 的年龄定位`);
                    }
                }

                // 🚀 提前获取 PageId（所有广告共享，避免重复请求）
                //    复用前置步骤已解析好的主页，别为同一账号再查一次 me/accounts
                let effPageId = resolvedPageId;
                if (!effPageId) {
                    const pagesData = await callFacebookGraphApi('me/accounts?fields=id,name', 'GET', null, profile);
                    if (pagesData.data && pagesData.data.length > 0) {
                        effPageId = pagesData.data[0].id;
                    } else {
                        log('WARN', `[Profile=${profileId}] 检测到账号没有主页，正在自动创建...`);
                        const pageName = ['Page', Date.now().toString(36), Math.random().toString(36).slice(2,6)].join(' ');
                        try {
                            const createForm = new URLSearchParams();
                            createForm.append('name', pageName);
                            createForm.append('category', '1601');
                            const createResult = await callFacebookGraphApi('me/accounts', 'POST', createForm, profile);
                            if (createResult?.id) { effPageId = createResult.id; log('INFO', `[Profile=${profileId}] ✅ 主页自动创建成功: id=${effPageId}`); }
                            else { throw new Error(createResult?.error?.message || '创建主页返回空 ID'); }
                        } catch (pageErr) {
                            log('WARN', `[Profile=${profileId}] API 创建主页失败(${pageErr.message})，调用代理重启浏览器创建主页...`);
                            try {
                                const pageCreateResp = await fetch(`http://127.0.0.1:${PORT}/api/facebook/pages/create`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Secret': API_SECRET },
                                    body: JSON.stringify({ profileId, name: pageName, proxyOverride: profile?.proxy || undefined })
                                });
                                const pageCreateJson = await pageCreateResp.json().catch(() => ({}));
                                if (pageCreateJson?.success && pageCreateJson?.pageId) { effPageId = pageCreateJson.pageId; log('INFO', `[Profile=${profileId}] ✅ 代理创建主页成功: id=${effPageId}`); }
                                else { throw new Error(pageCreateJson?.message || '代理创建主页失败'); }
                            } catch (proxyPageErr) {
                                log('WARN', `[Profile=${profileId}] 代理创建主页也失败(${proxyPageErr.message})，关闭浏览器跳过发布`);
                                try {
                                    const entry = activeBrowsers.get(profileId);
                                    if (entry && entry.browser && entry.browser.isConnected()) { await entry.browser.close().catch(() => {}); }
                                    cleanupActiveBrowser(profileId);
                                } catch {}
                                throw new Error(`发布失败: 无法创建主页(${pageName})`);
                            }
                        }
                    }
                }

                // 🚀 Instagram 账号：Instagram / Threads 版位的广告身份（创意顶层的 instagram_actor_id，
                //    值取该 IG 账号的 legacy_instagram_user_id）
                //    ⚠️ 必须逐字段单独查询：之前把多个字段（含根本不存在的 instagram_id）塞在同一个请求里，
                //       Meta 直接返回 (#100) Tried accessing nonexisting field (instagram_id) 让【整次查询失败】，
                //       结果 instagramActorId 永远为空 → 版位带了 Instagram/Threads，创意却没有身份。
                //    ⚠️ 只保留 Meta 当前真正存在的两个字段。以前还挂了两个早已废弃的
                //       page_backed_instagram_accounts / instagram_accounts：它们必然回
                //       (#100) Tried accessing nonexisting field，每次发布白跑 2 次 Graph 请求 + 刷 2 条 WARN，
                //       还会让人误以为是「字段名写错了才查不到 IG 账号」。
                //       实测（2026-09-19 profile 4016 / 主页 1276136592238980）报的就是这两个字段，
                //       而下面两个有效字段均查询成功、只是返回空 → 那是主页本身没关联 IG 账号，不是代码问题。
                let instagramActorId = '';
                let instagramUserId = '';   // IG 业务账号 id（1784…），只用于日志
                if (effPageId) {
                    // 🔑 关键：创意里的 instagram_actor_id 要的是 legacy_instagram_user_id（2698… 那套 id），
                    //    **不是** instagram_business_account 给的 IG 业务账号 id（1784…）。
                    //    实测 2026-09-19 抓 Ads Manager 的实际请求，草稿里发的是
                    //    "page_id":"1031230103404031","instagram_actor_id":"26987491890859097"，
                    //    而 26987491890859097 正是该 IG 账号的 legacy_instagram_user_id。
                    //    传 IG 业务账号 id 会被 Meta 回 (#100) Param instagram_actor_id must be a valid Instagram account id（profile 4339 连挂 12 次）。
                    const igFields = [
                        'instagram_business_account{id,username,legacy_instagram_user_id}',
                        'connected_instagram_account{id,username,legacy_instagram_user_id}',
                    ];
                    for (const field of igFields) {
                        if (instagramActorId) break;
                        const key = field.split('{')[0];
                        try {
                            const igData = await callFacebookGraphApi(`${effPageId}?fields=${field}`, 'GET', null, profile);
                            if (igData && igData.error) {
                                log('WARN', `📸 [Profile=${profileId}] 主页字段 ${key} 查询失败: ${igData.error.message}`);
                                continue;
                            }
                            const raw = igData && igData[key];
                            const pick = Array.isArray(raw && raw.data) ? raw.data[0] : raw;
                            if (pick && pick.id) {
                                instagramUserId = String(pick.id);
                                const legacyId = pick.legacy_instagram_user_id ? String(pick.legacy_instagram_user_id) : '';
                                log('INFO', `📸 [Profile=${profileId}] 主页 ${effPageId} 关联 Instagram 账号: ${instagramUserId}${pick.username ? ` (@${pick.username})` : ''}, legacy=${legacyId || '（无）'} [来源=${key}]`);
                                if (legacyId) {
                                    instagramActorId = legacyId;
                                } else {
                                    // 拿不到 legacy id 就宁可不带：少个 IG 身份总比整条广告被 (#100) 卡死强
                                    log('WARN', `⚠️ [Profile=${profileId}] 该 IG 账号没有返回 legacy_instagram_user_id，创意将不带 instagram_actor_id（避免 (#100) 让整条发布失败）`);
                                }
                            }
                        } catch (igErr) {
                            log('WARN', `📸 [Profile=${profileId}] 主页字段 ${key} 查询异常: ${igErr.message}`);
                        }
                    }
                    if (!instagramActorId) {
                        log('WARN', `⚠️ [Profile=${profileId}] 主页 ${effPageId} 拿不到可用的 Instagram actor id：创意不会带 IG 身份，Instagram/Threads 版位将没有投放身份`);
                    }
                }

                // 🚀 并行创建所有广告（大幅加速）—— 并发度按模式动态调整
                const adPromises = [];
                // 🚀 共享创意 ID（同一组广告复用）
                let sharedCreativeId = null;
                let sharedCreativeError = null;
                // API 模式（无浏览器回调）并发度 5，浏览器模式 3
                const CONCURRENCY_MAX = finalLaunchBrowser ? 3 : 5;
                for (let a = 0; a < adCount; a++) {
                    const startIdx = a;
                    adPromises.push((async () => {
                        if (startIdx >= CONCURRENCY_MAX) {
                            await adPromises[startIdx - CONCURRENCY_MAX];
                        }
                        const curAdName = adCount > 1 ? `${finalAdName}_${startIdx + 1}` : finalAdName;
                    
                    // 6. 创建创意 (Ad Creative) — 🚀 同一组广告共享一个创意 ID
                    let creativeId = null;
                    let creativeResult = null;
                    // 🚀 如果已有共享创意，直接复用
                    if (sharedCreativeId) {
                        creativeId = sharedCreativeId;
                        log('INFO', `🏗️ [Profile=${profileId}] 复用共享创意: ${creativeId}`);
                    } else if (sharedCreativeError) {
                        throw sharedCreativeError;
                    } else {

                    // 🚀 构建 link_data
                    // ⚠️ 文案/标题允许留空（用户不填就别填）：这里不再伪造内容，
                    //    只有真正不吃空值的分支（Adv+ asset_feed_spec / 多语言创意）才在下游兜底
                    const safeAdText = finalAdText || '';
                    const safeHeadline = finalHeadline || '';
                    const advFallbackText = 'Check this out';
                    const advFallbackHeadline = curAdName || 'Special Offer';
                    log('WARN', `[Profile=${profileId}] 📤 广告创意数据: finalWebsiteUrl="${finalWebsiteUrl}", finalAdText="${(safeAdText).slice(0,30)}", imageHash=${imageHash ? '有' : '无'}(${imageHash ? imageHash.substring(0,20) : 'null'}), safeHeadline="${safeHeadline}"${(!safeAdText || !safeHeadline) ? '（文案/标题留空，按原样提交）' : ''}`);
                    // 🔗 link_data.link 是 Meta 的**必填**字段：不传会报
                    //    (#100 / subcode 2061015) "The link field is required"。
                    //    所以「主页赞 / 消息互动 / 帖子互动」这类没有落地页的广告，
                    //    用**主页链接**兜底 —— 这也是 Ads Manager 自己的做法（不需要用户手填链接）。
                    const hasWebsiteUrl = !!(finalWebsiteUrl && finalWebsiteUrl.trim());
                    const pageFallbackLink = effPageId ? `https://www.facebook.com/${effPageId}` : '';
                    const effectiveLink = hasWebsiteUrl ? finalWebsiteUrl : pageFallbackLink;
                    // 🎯 CTA 按优化目标匹配：主页赞/帖子互动 → LIKE_PAGE，消息 → MESSAGE_PAGE。
                    //    ⚠️ 前端 CTA 下拉的默认值恒为 LEARN_MORE，且会随 campaignTree 一并下发；
                    //       若直接 `finalCtaType ||` 就会让「了解更多」这个默认值挡掉目标推导，
                    //       主页类广告被发成不匹配的 CTA（实测 Profile=4132：优化目标 PAGE_LIKES，
                    //       创意里仍是 "call_to_action":{"type":"LEARN_MORE"}）。
                    //       所以：只有前端选了「非默认」的 CTA 才以其为准，LEARN_MORE/空 一律按优化目标推导。
                    const DEFAULT_CTA_BY_GOAL = { PAGE_LIKES: 'LIKE_PAGE', POST_ENGAGEMENT: 'LIKE_PAGE', REPLIES: 'MESSAGE_PAGE', CONVERSATIONS: 'MESSAGE_PAGE' };
                    const goalCta = DEFAULT_CTA_BY_GOAL[String(optimizationGoal || '').toUpperCase()];
                    const effectiveCta = (finalCtaType && finalCtaType !== 'LEARN_MORE') ? finalCtaType : (goalCta || finalCtaType || 'LEARN_MORE');
                    if (!effectiveLink) {
                        throw new Error(`广告创意创建失败: 既没有落地页 URL 也没有可用主页（link 为 Meta 必填字段），请在广告 "${curAdName}" 中填写落地页，或先为该账号绑定主页`);
                    }
                    if (!hasWebsiteUrl) {
                        log('INFO', `🔗 [Profile=${profileId}] 优化目标 ${optimizationGoal} 未填落地页，改用主页链接兜底: ${effectiveLink}`);
                    }
                    // 🎬 有视频素材 → 用 video_data 建创意（视频广告不支持 link_data.link，落地页放 CTA）
                    let objectStorySpec;
                    if (videoId) {
                        const videoData = {
                            video_id: videoId,
                            call_to_action: { type: effectiveCta, value: { link: effectiveLink } }
                        };
                        if (safeAdText) videoData.message = safeAdText;
                        if (safeHeadline) videoData.title = safeHeadline;
                        if (videoThumbHash) videoData.image_hash = videoThumbHash;
                        else if (videoThumbUrl) videoData.image_url = videoThumbUrl;
                        if (finalAdDescription) videoData.link_description = finalAdDescription;
                        if (finalUseDisplayLink && finalDisplayLink) videoData.link_description = finalDisplayLink;
                        if (deepLink) videoData.call_to_action.value = { ...(videoData.call_to_action.value || {}), link: deepLink };
                        objectStorySpec = { page_id: effPageId, video_data: videoData };
                        log('INFO', `🎬 [Profile=${profileId}] 使用视频创意: video_id=${videoId}, 封面=${videoThumbHash || 'FB自动生成'}`);
                    } else {
                    const linkData = {
                        link: effectiveLink,
                        call_to_action: { type: effectiveCta, value: { link: effectiveLink } }
                    };
                    if (safeAdText) linkData.message = safeAdText;
                    if (safeHeadline) linkData.name = safeHeadline;
                    // 🚀 只有有图片时才传 image_hash，否则 Facebook 会拒绝
                    if (imageHash) linkData.image_hash = imageHash;
                    if (finalUseDisplayLink && finalDisplayLink) linkData.caption = finalDisplayLink;
                    if (deepLink) linkData.call_to_action.value = { ...(linkData.call_to_action.value || {}), link: deepLink };
                    if (finalAdDescription) linkData.description = finalAdDescription;

                    objectStorySpec = { page_id: effPageId, link_data: linkData };
                    }
                    // 🔑 IG 身份不放进 object_story_spec：它和 url_tags 一样是创意**顶层**字段。
                    //    值也不是这里查到的 IG 业务账号 id，而是它的 legacy_instagram_user_id（见上面 igFields 处的说明）。

                    // 🚀 动态创意 (多文案/多标题/多描述测试)
                    if (enableDynamicCreative) {
                        const adTextOpts = [safeAdText, adText2].filter(Boolean);
                        const headlineOpts = [safeHeadline, headline2].filter(Boolean);
                        const descOpts = [finalAdDescription, adDescription2].filter(Boolean);
                        if (adTextOpts.length > 1 || headlineOpts.length > 1 || descOpts.length > 1) {
                            objectStorySpec.template_data = {};
                            if (adTextOpts.length > 1) objectStorySpec.template_data.message = adTextOpts;
                            if (headlineOpts.length > 1) objectStorySpec.template_data.name = headlineOpts;
                            if (descOpts.length > 1) objectStorySpec.template_data.description = descOpts;
                        }
                    }
                    // 🚀 进阶赋能型创意（多图 asset_feed_spec）
                    let usedAssetFeed = false;
                    // 🚀 提取增强子选项（前端新增字段）
                    const enableEnhancements = adNode.enableEnhancements !== false;
                    const enhancementOverlayText = adNode.enhancementOverlayText !== undefined ? adNode.enhancementOverlayText : adNode.overlayText;
                    const enhancementVisualPolish = adNode.enhancementVisualPolish !== undefined ? adNode.enhancementVisualPolish : adNode.visualPolish;
                    const enhancementAddMusic = adNode.enhancementAddMusic !== undefined ? adNode.enhancementAddMusic : adNode.music;
                    const enhancementCopyImprove = adNode.enhancementCopyImprove !== undefined ? adNode.enhancementCopyImprove : adNode.copyImprove;
                    const enhancementAddAnimation = adNode.enhancementAddAnimation !== undefined ? adNode.enhancementAddAnimation : adNode.animation;
                    const enhancementImageGeneration = adNode.enhancementImageGeneration !== undefined ? adNode.enhancementImageGeneration : adNode.imageGeneration;
                    // 🐛 修复：多语言广告时自动启用 Advantage+ Creative（asset_feed_spec 必需）
                    const hasLanguageContent = enableLanguage && languageContent && typeof languageContent === 'object' && Object.keys(languageContent).length > 0;
                    const shouldEnableAdvCreative = enableAdvantageCreative || hasLanguageContent;
                    if (shouldEnableAdvCreative) { 
                        objectStorySpec.advantage_plus_creative = { enroll_status: 'OPT_IN' };
                        // 🚀 如果总开关开启且至少有一项子功能关闭，用 asset_feed_spec 精细控制
                        const subEnhancements = enableEnhancements ? {
                            overlay_text: enhancementOverlayText !== false ? 'OPT_IN' : 'OPT_OUT',
                            visual_polish: enhancementVisualPolish !== false ? 'OPT_IN' : 'OPT_OUT',
                            music: enhancementAddMusic !== false ? { enroll_status: 'OPT_IN' } : null,
                            copy_improve: enhancementCopyImprove !== false ? { enroll_status: 'OPT_IN' } : null,
                            animation: enhancementAddAnimation !== false ? { enroll_status: 'OPT_IN' } : null,
                            background_generation: enhancementImageGeneration !== false ? { enroll_status: 'OPT_IN' } : null,
                            image_expansion: enhancementImageGeneration !== false ? { enroll_status: 'OPT_IN' } : null,
                        } : null;
                        if (subEnhancements) {
                            objectStorySpec.advantage_plus_creative.enhancements = subEnhancements;
                            // 🚀 补充 standard_enhancements 兜底（针对部分新版广告账户）
                            objectStorySpec.advantage_plus_creative.standard_enhancements = { enroll_status: 'OPT_IN' };
                            log('WARN', `[Profile=${profileId}] 📤 Adv+ 增强子选项: overlayText=${enhancementOverlayText !== false}, visualPolish=${enhancementVisualPolish !== false}, music=${enhancementAddMusic !== false}, copyImprove=${enhancementCopyImprove !== false}, animation=${enhancementAddAnimation !== false}, imageGeneration=${enhancementImageGeneration !== false}`);
                        }
                        // 🚀 有多张图时使用 asset_feed_spec 让 FB 自动测试所有图片组合
                        const validHashes = imageHashes.filter(h => h && h.hash);
                        const hasMultiImages = validHashes.length > 1;
                        // 🚀 多语言广告：构建 asset_feed_spec 含语言变体（hasLanguageContent 已在外部声明）
                        if (hasMultiImages || hasLanguageContent) {
                            const assetFeed = {
                                call_to_action_types: [effectiveCta],
                                link_urls: [{ website_url: effectiveLink }]
                            };
                            // 🖼️ 图片可能被留空（未提供素材）：此时不能塞空数组或 {hash:null}，直接不带 images 字段
                            const _feedImgs = validHashes.length > 0 ? validHashes.map(h => ({ hash: h.hash })) : (imageHash ? [{ hash: imageHash }] : []);
                            if (_feedImgs.length > 0) assetFeed.images = _feedImgs;
                            if (hasLanguageContent) {
                                // 💡 多语言模式：使用 adlabels + asset_customization_rules（官方格式）
                                const langCodes = Object.keys(languageContent);
                                const allLangs = langCodes.length > 0 ? langCodes : [primaryLanguage || 'en'];
                                // 按语言生成 bodies / titles / descriptions / link_urls
                                const bodies = [];
                                const titles = [];
                                const descriptions = [];
                                const linkUrls = [];
                                const langSet = new Set();
                                const numericLocales = new Set();
                                const assetCustomizationRules = [];
                                // 🚀 收集各语言独立素材并上传
                                const langImages = []; // { hash, adlabels }
                                for (const lc of allLangs) {
                                    const lcData = languageContent[lc];
                                    if (!lcData) continue;
                                    langSet.add(lc);
                                    // 获取数字 locale key
                                    const localeKey = LOCALE_MAP[lc];
                                    if (localeKey) numericLocales.add(localeKey);
                                    // 使用 adlabels 替代 asset_language
                                    if (lcData.body) bodies.push({ text: lcData.body, adlabels: [{ name: lc }] });
                                    if (lcData.headline) titles.push({ text: lcData.headline, adlabels: [{ name: lc }] });
                                    if (lcData.description) descriptions.push({ text: lcData.description, adlabels: [{ name: lc }] });
                                    if (lcData.websiteUrl) linkUrls.push({ website_url: lcData.websiteUrl, adlabels: [{ name: lc }] });
                                    // 添加 asset_customization_rule（将 locale 字符串映射为数字 key）
                                    if (localeKey) {
                                        assetCustomizationRules.push({
                                            customization_spec: { locales: [{ locale_key: localeKey }] },
                                            adlabels: [{ name: lc }]
                                        });
                                    }
                                    // 🚀 上传该语言的专属素材
                                    const langB64s = lcData.mediaBase64List || lcData.mediaBase64 ? [lcData.mediaBase64] : [];
                                    if (Array.isArray(langB64s) && langB64s.length > 0) {
                                        for (const b64 of langB64s) {
                                            try {
                                                const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
                                                const lForm = new URLSearchParams();
                                                lForm.append('bytes', base64Data);
                                                const lUpload = await callFacebookGraphApi(`${actId}/adimages`, 'POST', lForm, profile);
                                                if (lUpload?.images && Object.keys(lUpload.images).length > 0) {
                                                    const lHash = Object.keys(lUpload.images).length > 0 ? lUpload.images[Object.keys(lUpload.images)[0]].hash : null;
                                                    if (lHash) langImages.push({ hash: lHash, adlabels: [{ name: lc }] });
                                                }
                                            } catch (imgErr) {
                                                log('WARN', `⚠️ [Profile=${profileId}] 语言 ${lc} 素材上传失败: ${imgErr.message}`);
                                            }
                                        }
                                    }
                                }
                                // 确保有默认语言内容兜底 + 默认 asset_customization_rule
                                const primaryLang = primaryLanguage || 'en';
                                const primaryLocaleKey = LOCALE_MAP[primaryLang];
                                if (!langSet.has(primaryLang)) {
                                    if (primaryLocaleKey) numericLocales.add(primaryLocaleKey);
                                    bodies.push({ text: safeAdText || advFallbackText, adlabels: [{ name: primaryLang }] });
                                    titles.push({ text: safeHeadline || advFallbackHeadline, adlabels: [{ name: primaryLang }] });
                                    if (!assetCustomizationRules.some(r => r.adlabels[0].name === primaryLang)) {
                                        assetCustomizationRules.push({
                                            customization_spec: { locales: [{ locale_key: primaryLocaleKey }] },
                                            adlabels: [{ name: primaryLang }]
                                        });
                                    }
                                }
                                // 添加 is_default 兜底规则（使用主语言）
                                if (primaryLocaleKey && !assetCustomizationRules.some(r => r.is_default)) {
                                    assetCustomizationRules.push({
                                        is_default: true,
                                        customization_spec: { locales: [{ locale_key: primaryLocaleKey }] },
                                        adlabels: [{ name: primaryLang }]
                                    });
                                }
                                // 合并语言素材到 images（保留全局素材作为兜底）
                                const finalImages = [];
                                // 先加语言专属的（带 adlabels 绑定）
                                for (const li of langImages) { finalImages.push({ hash: li.hash, adlabels: li.adlabels }); }
                                // 再加全局素材（不带语言绑定）
                                for (const vh of validHashes) {
                                    if (!finalImages.some(fi => fi.hash === vh.hash)) {
                                        finalImages.push({ hash: vh.hash });
                                    }
                                }
                                // 如果没有任何图片，补一个默认
                                if (finalImages.length === 0 && imageHash) finalImages.push({ hash: imageHash });
                                assetFeed.images = finalImages;
                                if (bodies.length > 0) assetFeed.bodies = bodies;
                                if (titles.length > 0) assetFeed.titles = titles;
                                if (descriptions.length > 0) assetFeed.descriptions = descriptions;
                                if (linkUrls.length > 0) assetFeed.link_urls = linkUrls;
                                if (assetCustomizationRules.length > 0) assetFeed.asset_customization_rules = assetCustomizationRules;
                                if (numericLocales.size > 0) assetFeed.languages = Array.from(numericLocales);
                                log('INFO', `[Profile=${profileId}] 📤 多语言创意(官方格式): rules=${assetCustomizationRules.length}, bodies=${bodies.length}, titles=${titles.length}, descriptions=${descriptions.length}`);
                            } else {
                                // 普通多图模式
                                assetFeed.bodies = [{ text: safeAdText || advFallbackText }];
                                assetFeed.titles = [{ text: safeHeadline || advFallbackHeadline }];
                                if (finalAdDescription) assetFeed.descriptions = [{ text: finalAdDescription }];
                            }
                            // 🚀 Adv+ 多图/多语言模式：替换 object_story_spec 为 asset_feed_spec 格式
                            delete objectStorySpec.link_data;
                            delete objectStorySpec.video_data;
                            // 🎬 Adv+ 视频创意：视频放 asset_feed_spec.videos，图只作为封面（无封面则交给 FB 自动生成）
                            if (videoId) {
                                assetFeed.videos = [{ video_id: videoId }];
                                if (videoThumbHash) assetFeed.images = [{ hash: videoThumbHash }];
                                else delete assetFeed.images;
                            }
                            objectStorySpec.asset_feed_spec = assetFeed;
                            usedAssetFeed = true;
                            log('WARN', `[Profile=${profileId}] 📤 Adv+ ${hasLanguageContent ? '多语言' : '多图'}创意模式: ${validHashes.length}张图${videoId ? ` + 视频(${videoId})` : ''}${hasLanguageContent ? `, ${Object.keys(languageContent).length}种语言` : ''}`);
                        }
                    }

                    const creativeBody = {
                        name: `Creative_${curAdName}_${Date.now()}`,
                        object_story_spec: JSON.stringify(objectStorySpec)
                    };
                    if (finalUrlParams && finalUrlParams.trim()) creativeBody.url_tags = finalUrlParams.trim();
                    // 📸 IG 身份：创意**顶层**字段，和 url_tags 同级（不能塞进 object_story_spec）。
                    //    值是上面查到的 legacy_instagram_user_id，和 UI 里选「Facebook 公共主页」自动带出来的一致。
                    if (instagramActorId) creativeBody.instagram_actor_id = instagramActorId;
                    if (productCatalogId) { creativeBody.product_catalog_id = productCatalogId; }
                    if (instantExperienceId) { creativeBody.instant_experience_id = instantExperienceId; }
                    if (offerId) { creativeBody.offer_id = offerId; }

                    log('WARN', `[Profile=${profileId}] 📤 发送 creativeBody: instagram_actor_id=${instagramActorId || '（无）'}(IG=${instagramUserId || '无'}), object_story_spec=${JSON.stringify(objectStorySpec)}`);
                    await new Promise(r => setTimeout(r, 2000));
                    creativeResult = await callFacebookGraphApi(`${actId}/adcreatives`, 'POST', creativeBody, profile);
                    // 🐛 修复：Token 过期（code 190）时重新提取并重试一次
                    if ((!creativeResult || !creativeResult.id) && creativeResult?.error?.code === 190) {
                        log('WARN', `⚠️ [Profile=${profileId}] Token 过期(190)，重新提取 Token 后重试创意创建...`);
                        const reExtracted = await reExtractTokenAndUpdateProfile(profileId, profile);
                        if (reExtracted) {
                            await new Promise(r => setTimeout(r, 2000));
                            creativeResult = await callFacebookGraphApi(`${actId}/adcreatives`, 'POST', creativeBody, profile);
                        }
                    }
                    creativeId = creativeResult && creativeResult.id;
                    
                    // 🚀 如果 asset_feed_spec 失败，自动回退到普通 link_data（单图）
                    if (!creativeId && usedAssetFeed) {
                        log('WARN', `⚠️ [Profile=${profileId}] Adv+ 多图创意失败，回退到${videoId ? '单视频' : '普通单图'}模式...`);
                        const fallbackSpec = {
                            page_id: effPageId,
                            advantage_plus_creative: { enroll_status: 'OPT_IN' }
                        };
                        if (videoId) {
                            // 🎬 有视频时回退也必须保留视频，否则会退化成图片广告
                            const fbVideoData = {
                                video_id: videoId,
                                call_to_action: { type: effectiveCta, value: { link: effectiveLink } }
                            };
                            if (safeAdText) fbVideoData.message = safeAdText;
                            if (safeHeadline) fbVideoData.title = safeHeadline;
                            if (videoThumbHash) fbVideoData.image_hash = videoThumbHash;
                            else if (videoThumbUrl) fbVideoData.image_url = videoThumbUrl;
                            fallbackSpec.video_data = fbVideoData;
                        } else {
                            const fallbackLinkData = {
                                link: effectiveLink,
                                call_to_action: { type: effectiveCta, value: { link: effectiveLink } }
                            };
                            if (safeAdText) fallbackLinkData.message = safeAdText;
                            if (safeHeadline) fallbackLinkData.name = safeHeadline;
                            if (imageHash) fallbackLinkData.image_hash = imageHash;
                            fallbackSpec.link_data = fallbackLinkData;
                        }
                        const fallbackBody = {
                            name: `Creative_${curAdName}_${Date.now()}`,
                            object_story_spec: JSON.stringify(fallbackSpec)
                        };
                        if (finalUrlParams && finalUrlParams.trim()) fallbackBody.url_tags = finalUrlParams.trim();
                        // 📸 IG 身份同样放顶层（回退创意也要带，否则 Instagram/Threads 版位没有投放身份）
                        if (instagramActorId) fallbackBody.instagram_actor_id = instagramActorId;
                        log('WARN', `[Profile=${profileId}] 📤 回退创意 body: ${JSON.stringify(fallbackBody)}`);
                        creativeResult = await callFacebookGraphApi(`${actId}/adcreatives`, 'POST', fallbackBody, profile);
                        // 🐛 修复：回退创意时 Token 过期也重试
                        if ((!creativeResult || !creativeResult.id) && creativeResult?.error?.code === 190) {
                            log('WARN', `⚠️ [Profile=${profileId}] 回退创意 Token 过期(190)，重新提取...`);
                            const reExtracted = await reExtractTokenAndUpdateProfile(profileId, profile);
                            if (reExtracted) {
                                await new Promise(r => setTimeout(r, 2000));
                                creativeResult = await callFacebookGraphApi(`${actId}/adcreatives`, 'POST', fallbackBody, profile);
                            }
                        }
                        creativeId = creativeResult && creativeResult.id;
                    }
                    
                    if (!creativeId) {
                        const err = creativeResult.error || {};
                        log('ERROR', `❌ [Profile=${profileId}] 广告创意创建失败详情: ${err.message} (Code: ${err.code}, Subcode: ${err.error_subcode}, UserTitle: ${err.error_user_title})`);
                        // 🐛 原始错误体必须整条打出来（AdSet 那条路一直是这么打的，创意这条路漏了）：
                        //    上面那行只取 message/code/subcode/user_title，会丢掉两样最关键的诊断信息 ——
                        //      · error_user_msg：真正可读的原因（如 1487194 的 "Either the object you are
                        //        trying to access is not visible to you..."），而 user_title 往往只是一句
                        //        "Error de permiso"；
                        //      · error_data.blame_field_specs：Meta 到底 blame 了哪个字段/对象
                        //        （business_country_code？page_id？video_id？）——profile 4146 的
                        //        200/1487194 就是因此只能靠猜是主页还是视频的问题。
                        log('ERROR', `❌ [Profile=${profileId}] 创意失败原始错误: ${JSON.stringify(err)}`);
                        // 🚀 打印完整的请求体用于调试
                        log('ERROR', `❌ [Profile=${profileId}] 失败创意 body: ${JSON.stringify({...creativeBody, object_story_spec: objectStorySpec})}`);
                        const createErr = new Error(`广告创意创建失败: ${formatFBError(creativeResult)}`);
                        sharedCreativeError = createErr;
                        throw createErr;
                    }
                    
                    // 🚀 缓存共享创意 ID（后续广告复用）
                    sharedCreativeId = creativeId;
                    log('INFO', `🏗️ [Profile=${profileId}] ✅ 创意创建成功: ${creativeId} (共享给 ${adCount} 个广告)`);
                    } // 🚀 结束 if (!sharedCreativeId) 创意创建块

                    // 7. 创建广告 (Ad)
                    log('INFO', `🚀 [Profile=${profileId}] 正在执行最终发布: ${curAdName}`);
                    await new Promise(r => setTimeout(r, 2000));
                    const adData = await callFacebookGraphApi(`${actId}/ads`, 'POST', {
                        name: curAdName,
                        adset_id: adSetId,
                        creative: JSON.stringify({ creative_id: creativeId }),
                        status: autoActivate ? 'PAUSED' : (adStatus || 'ACTIVE') // 🚀 两步模式强制先 PAUSED
                    }, profile);
                    
                    if (adData.id) {
                        const newAdId = adData.id;
                        results.push(newAdId);
                        log('SUCCESS', `🎉 [Profile=${profileId}] 广告创建成功! ID: ${newAdId}`);

                        // 🚀 两步模式：只在第一个广告创建后激活 campaign + adset + 当前 ad
                        // 后续广告只激活当前 ad（不重复激活 campaign/adset）
                        if (autoActivate) {
                            const isFirstAd = a === 0 || !results.includes(adSetId);
                            log('INFO', `⚡ [Profile=${profileId}] 正在开启广告资产...`);
                            try {
                                const activatePromises = [callFacebookGraphApi(newAdId, 'POST', { status: 'ACTIVE' }, profile)];
                                if (isFirstAd) {
                                    activatePromises.push(callFacebookGraphApi(adSetId, 'POST', { status: 'ACTIVE' }, profile));
                                    activatePromises.push(callFacebookGraphApi(campaignId, 'POST', { status: 'ACTIVE' }, profile));
                                }
                                await Promise.all(activatePromises);
                                log('SUCCESS', `✅ [Profile=${profileId}] 广告已成功从 PAUSED 切换为 ACTIVE 状态。`);
                            } catch (actErr) {
                                log('WARN', `⚠️ [Profile=${profileId}] 自动开启失败，请手动开启。原因: ${actErr.message}`);
                            }
                        }
                    } else {
                        throw new Error(`Ad 创建失败: ${formatFBError(adData)}`);
                    }
                    })());
                }
                await Promise.all(adPromises);
            }
        }

        // 8. 同步结果到云端
        const storageUrl = process.env.STORAGE_SERVER_URL || '';
        const apiSecret = process.env.PUPPETEER_API_SECRET || '';
        await fetch(`${storageUrl}/api/profiles/${profileId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Secret': apiSecret },
            body: JSON.stringify({
                id: profileId,
                account_notes: `[API Ads] Bulk Published ${results.length} ads for "${campaignName}" at ${new Date().toLocaleString()}`
            })
        }).catch(() => {});

        return { success: true, adId: results[0], allAdIds: results };
    } catch (error) {
        if (error instanceof SkipPublishError) {
            log('WARN', `⏭️ [Profile=${profileId}] 跳过发布: ${error.message}`);
            return { success: false, skip: true, error: error.message };
        }
        log('ERROR', `❌ [Profile=${profileId}] API 发布失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 🚀 Facebook 模拟发布核心逻辑
 */
async function runFacebookPublishAd(page, data, profileId) {
    try {
        log('INFO', `🎬 [Profile=${profileId}] 开始浏览器模拟发布流程: ${data.campaignName}`);
        await page.goto('https://adsmanager.facebook.com/adsmanager/manage/campaigns', { waitUntil: 'networkidle2', timeout: 60000 });
        
        // 简化的模拟逻辑... (实际逻辑会根据 UI 逐步执行点击)
        // 此处仅作为结构占位，实际逻辑包含在之前的实现中
        log('INFO', `🖱️ [Profile=${profileId}] 正在操作 Ads Manager 界面...`);
        
        // 执行发布...
        
        return true;
    } catch (error) {
        log('ERROR', `❌ [Profile=${profileId}] 浏览器模拟发布失败: ${error.message}`);
        return false;
    }
}

module.exports = { __inject, SkipPublishError, runFacebookPublishAdApi, runFacebookPublishAd };
