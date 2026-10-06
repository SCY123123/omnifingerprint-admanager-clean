/**
 * Google Ads API 服务模块
 * 基于 Google Ads REST API v17
 * 支持：Search / Display / Video 广告系列的批量创建
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const GOOGLE_ADS_API_BASE = 'googleads.googleapis.com';
const GOOGLE_ADS_API_VERSION = 'v17';
const OAUTH_TOKEN_URL = 'oauth2.googleapis.com';

/**
 * 通过 OAuth2 获取访问令牌（使用刷新令牌）
 */
async function getAccessToken(clientId, clientSecret, refreshToken) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        }).toString();
        const req = https.request({
            hostname: OAUTH_TOKEN_URL,
            path: '/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j.access_token) resolve(j.access_token);
                    else reject(new Error(`OAuth 错误: ${JSON.stringify(j)}`));
                } catch (e) { reject(new Error(`OAuth 解析失败: ${data.substring(0,200)}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * 调用 Google Ads REST API
 */
async function callGoogleAdsApi(endpoint, method, body, accessToken, developerToken, customerId) {
    return new Promise((resolve, reject) => {
        const b = body ? JSON.stringify(body) : null;
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'developer-token': developerToken,
            'login-customer-id': customerId
        };
        if (b) headers['Content-Length'] = Buffer.byteLength(b);
        const req = https.request({
            hostname: GOOGLE_ADS_API_BASE,
            path: `/v17/customers/${customerId}/${endpoint}`,
            method,
            headers
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
                    else reject(new Error(`Google Ads API 错误 [${res.statusCode}]: ${JSON.stringify(j.error || j).substring(0,300)}`));
                } catch (e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ raw: data });
                    else reject(new Error(`Google Ads API 错误 [${res.statusCode}]: ${data.substring(0,300)}`));
                }
            });
        });
        req.on('error', reject);
        if (b) req.write(b);
        req.end();
    });
}

/**
 * 调用 Google Ads Search API (用于获取账户信息、报告等)
 */
async function searchGoogleAds(accessToken, developerToken, customerId, query) {
    return callGoogleAdsApi('googleAds:search', 'POST', { query }, accessToken, developerToken, customerId);
}

// ===== 广告系列常量映射 =====
const CAMPAIGN_TYPE_MAP = {
    SEARCH: 'SEARCH',
    DISPLAY: 'DISPLAY',
    VIDEO: 'VIDEO',
    SHOPPING: 'SHOPPING',
    PERFORMANCE_MAX: 'PERFORMANCE_MAX',
    SMART: 'SMART',
    APP: 'APP'
};

const BIDDING_STRATEGY_MAP = {
    MANUAL_CPC: 'MANUAL_CPC',
    TARGET_CPA: 'TARGET_CPA',
    TARGET_ROAS: 'TARGET_ROAS',
    MAXIMIZE_CLICKS: 'MAXIMIZE_CLICKS',
    MAXIMIZE_CONVERSIONS: 'MAXIMIZE_CONVERSIONS',
    MANUAL_CPM: 'MANUAL_CPM',
    TARGET_IMPRESSION_SHARE: 'TARGET_IMPRESSION_SHARE',
    ENHANCED_CPC: 'ENHANCED_CPC',
    TARGET_SPEND: 'TARGET_SPEND',
    PERCENT_CPC: 'PERCENT_CPC',
    NONE: ''
};

const NETWORK_SETTINGS = {
    SEARCH: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    DISPLAY: { targetGoogleSearch: false, targetSearchNetwork: false, targetContentNetwork: true, targetPartnerSearchNetwork: false },
    SEARCH_DISPLAY: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: true, targetPartnerSearchNetwork: false },
    YOUTUBE: { targetGoogleSearch: false, targetSearchNetwork: false, targetContentNetwork: true, targetPartnerSearchNetwork: false }
};

const AD_TYPE_MAP = {
    RESPONSIVE_SEARCH_AD: 'RESPONSIVE_SEARCH_AD',
    EXPANDED_TEXT_AD: 'EXPANDED_TEXT_AD',
    DISPLAY_AD: 'DISPLAY_AD',
    VIDEO_AD: 'VIDEO_AD',
    RESPONSIVE_DISPLAY_AD: 'RESPONSIVE_DISPLAY_AD',
    APP_AD: 'APP_AD'
};

function microsFromAmount(amount) {
    return String(Math.round(parseFloat(String(amount || '0')) * 1000000));
}

function amountFromMicros(micros) {
    return String(parseInt(String(micros || '0')) / 1000000);
}

// ===== 核心函数：批量发布广告 =====

/**
 * 创建广告系列 (Campaign)
 */
async function createCampaign(accessToken, devToken, customerId, campaign) {
    const { name, type, budget, biddingStrategy, targetCpa, targetRoas, status, startDate, endDate, networkSetting, languages, locations } = campaign;
    const campaignBudget = {
        name: `Budget_${name}_${Date.now()}`,
        amountMicros: microsFromAmount(budget),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false
    };
    // 先创建预算
    const budgetResult = await callGoogleAdsApi('campaignBudgets', 'POST', campaignBudget, accessToken, devToken, customerId);
    const budgetResourceName = budgetResult.resourceName || budgetResult;
    // 创建系列
    const campaignBody = {
        name,
        status: status === 'ACTIVE' ? 'ENABLED' : 'PAUSED',
        advertisingChannelType: CAMPAIGN_TYPE_MAP[type] || 'SEARCH',
        campaignBudget: budgetResourceName,
        startDate: startDate || new Date().toISOString().slice(0,10).replace(/-/g, ''),
        endDate: endDate ? endDate.replace(/-/g, '') : undefined,
        networkSettings: NETWORK_SETTINGS[networkSetting] || NETWORK_SETTINGS.SEARCH,
        ...(biddingStrategy ? buildBidding(biddingStrategy, targetCpa, targetRoas) : {}),
        ...(languages?.length ? { targetingSetting: { targetRestrictions: languages.map(l => ({ targetingDimension: 'LANGUAGE', bidOnly: true })) } } : {}),
        ...(locations?.length ? { criteria: locations.map(l => ({ type: 'LOCATION', geoPoint: l })) } : {}),
        urlExpansionOptOut: false,
        optimizationGoalSetting: { optimizationGoalTypes: ['MAXIMIZE_CONVERSIONS'] }
    };
    const result = await callGoogleAdsApi('campaigns', 'POST', campaignBody, accessToken, devToken, customerId);
    return { campaignId: extractId(result.resourceName), resourceName: result.resourceName, budgetResourceName };
}

function buildBidding(strategy, targetCpa, targetRoas) {
    switch (strategy) {
        case 'MANUAL_CPC': return { biddingStrategyType: 'MANUAL_CPC', manualCpc: { enhancedCpcEnabled: false } };
        case 'ENHANCED_CPC': return { biddingStrategyType: 'MANUAL_CPC', manualCpc: { enhancedCpcEnabled: true } };
        case 'TARGET_CPA': return { biddingStrategyType: 'TARGET_CPA', targetCpa: { targetCpaMicros: microsFromAmount(targetCpa || '1') } };
        case 'TARGET_ROAS': return { biddingStrategyType: 'TARGET_ROAS', targetRoas: { targetRoasMicros: microsFromAmount(targetRoas || '1') } };
        case 'MAXIMIZE_CLICKS': return { biddingStrategyType: 'MAXIMIZE_CLICKS', maximizeClicks: { targetCpaMicros: 0 } };
        case 'MAXIMIZE_CONVERSIONS': return { biddingStrategyType: 'MAXIMIZE_CONVERSIONS', maximizeConversions: { targetCpaMicros: 0 } };
        case 'TARGET_IMPRESSION_SHARE': return { biddingStrategyType: 'TARGET_IMPRESSION_SHARE', targetImpressionShare: { location: 'ANYWHERE', locationPercentage: 100 } };
        default: return {};
    }
}

function extractId(resourceName) {
    if (!resourceName) return '';
    const parts = String(resourceName).split('/');
    return parts[parts.length - 1];
}

/**
 * 创建广告组 (AdGroup)
 */
async function createAdGroup(accessToken, devToken, customerId, adGroup, campaignResourceName) {
    const { name, type, status, cpcBid, cpmBid, cpaBid, keywords, audiences } = adGroup;
    const body = {
        name,
        status: status === 'ACTIVE' ? 'ENABLED' : 'PAUSED',
        campaign: campaignResourceName,
        type: type === 'DISPLAY' ? 'DISPLAY_STANDARD' : type === 'VIDEO' ? 'VIDEO_STANDARD' : 'SEARCH_STANDARD',
        ...(cpcBid ? { cpcBidMicros: microsFromAmount(cpcBid) } : {}),
        ...(cpmBid ? { cpmBidMicros: microsFromAmount(cpmBid) } : {}),
        ...(cpaBid ? { targetCpaMicros: microsFromAmount(cpaBid) } : {}),
        targetingSetting: {
            targetRestrictions: [
                { targetingDimension: 'KEYWORD', bidOnly: false }
            ]
        }
    };
    const result = await callGoogleAdsApi('adGroups', 'POST', body, accessToken, devToken, customerId);
    const adGroupResourceName = result.resourceName;
    const adGroupId = extractId(adGroupResourceName);
    // 批量创建关键词
    const keywordResults = [];
    if (keywords && keywords.length) {
        for (const kw of keywords) {
            try {
                const kr = await callGoogleAdsApi('adGroupCriteria', 'POST', {
                    adGroup: adGroupResourceName,
                    status: 'ENABLED',
                    keyword: { text: kw.text || kw, matchType: (kw.matchType || 'PHRASE').toUpperCase() }
                }, accessToken, devToken, customerId);
                keywordResults.push({ text: kw.text || kw, keywordId: extractId(kr.resourceName) });
            } catch (e) { keywordResults.push({ text: kw.text || kw, error: e.message }); }
        }
    }
    return { adGroupId, adGroupResourceName, keywords: keywordResults };
}

/**
 * 创建广告 (Ad)
 */
async function createAd(accessToken, devToken, customerId, ad, adGroupResourceName) {
    const { name, adType, headlines, descriptions, finalUrl, finalMobileUrl, path1, path2, imageHash, videoId, displayUrl, ctaText, businessName, longHeadline, marketingImageHash, logoImageHash, callToActionText, status } = ad;
    let adBody;
    const adName = name || `Ad_${Date.now()}`;
    const adGroupAd = {
        adGroup: adGroupResourceName,
        status: status === 'ACTIVE' ? 'ENABLED' : 'PAUSED',
        ad: {
            finalUrls: [finalUrl || 'https://example.com'],
            ...(finalMobileUrl ? { finalMobileUrls: [finalMobileUrl] } : {}),
            ...(displayUrl ? { displayUrl } : {}),
            urlCustomParameters: []
        }
    };
    switch (adType || 'RESPONSIVE_SEARCH_AD') {
        case 'RESPONSIVE_SEARCH_AD':
            adGroupAd.ad.responsiveSearchAd = {
                headlines: (headlines || []).slice(0, 15).map(h => ({ text: h })),
                descriptions: (descriptions || []).slice(0, 4).map(d => ({ text: d })),
                ...(path1 ? { path1 } : {}),
                ...(path2 ? { path2 } : {})
            };
            break;
        case 'EXPANDED_TEXT_AD':
            adGroupAd.ad.expandedTextAd = {
                headlinePart1: (headlines || [''])[0] || '',
                headlinePart2: (headlines || ['', ''])[1] || '',
                description: (descriptions || [''])[0] || '',
                ...(path1 ? { path1 } : {}),
                ...(path2 ? { path2 } : {})
            };
            break;
        case 'RESPONSIVE_DISPLAY_AD':
            adGroupAd.ad.responsiveDisplayAd = {
                headlines: (headlines || []).slice(0, 5).map(h => ({ text: h })),
                descriptions: (descriptions || []).slice(0, 5).map(d => ({ text: d })),
                ...(businessName ? { businessName } : {}),
                ...(callToActionText ? { callToActionText } : {}),
                ...(marketingImageHash ? { marketingImages: [{ asset: marketingImageHash }] } : {}),
                ...(logoImageHash ? { logoImages: [{ asset: logoImageHash }] } : {}),
                ...(longHeadline ? { longHeadline: longHeadline } : {}),
                squareMarketingImages: marketingImageHash ? [{ asset: marketingImageHash }] : []
            };
            break;
        case 'VIDEO_AD':
            adGroupAd.ad.videoAd = {
                ...(videoId ? { videoId } : {}),
                inStream: { actionButtonLabel: ctaText || '了解更多', actionHeadline: (headlines || [''])[0] || '' }
            };
            break;
        case 'DISPLAY_AD':
            adGroupAd.ad.displayAd = {
                headlinePart1: (headlines || [''])[0] || '',
                headlinePart2: (headlines || ['', ''])[1] || '',
                description: (descriptions || [''])[0] || '',
                ...(imageHash ? { imageAsset: imageHash } : {}),
                ...(businessName ? { businessName } : {}),
                ...(callToActionText ? { callToActionText } : {}),
                squareMarketingImage: imageHash
            };
            break;
    }
    const result = await callGoogleAdsApi('adGroupAds', 'POST', adGroupAd, accessToken, devToken, customerId);
    return { adId: extractId(result.resourceName), resourceName: result.resourceName };
}

/**
 * 主发布函数：批量创建 Campaign → AdGroup → Ad
 * tree 结构: [{ name, type, budget, biddingStrategy, adGroups: [{ name, keywords, ads: [...] }] }]
 */
async function publishGoogleAds(accessToken, devToken, customerId, tree, options = {}) {
    const results = { campaigns: [] };
    for (const campaign of tree) {
        const campaignResult = await createCampaign(accessToken, devToken, customerId, { ...campaign, ...options });
        const adGroupResults = [];
        const adGroups = campaign.adGroups || [];
        for (const ag of adGroups) {
            const agResult = await createAdGroup(accessToken, devToken, customerId, ag, campaignResult.resourceName);
            const adResults = [];
            const ads = ag.ads || [];
            for (const ad of ads) {
                const adResult = await createAd(accessToken, devToken, customerId, ad, agResult.adGroupResourceName);
                adResults.push(adResult);
            }
            adGroupResults.push({ ...agResult, ads: adResults });
        }
        results.campaigns.push({ ...campaignResult, adGroups: adGroupResults });
    }
    return results;
}

/**
 * 获取 Google Ads 客户账户列表
 */
async function listAccessibleCustomers(accessToken, devToken) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: GOOGLE_ADS_API_BASE,
            path: `/v17/customers:listAccessibleCustomers`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'developer-token': devToken,
                'Content-Type': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * 获取客户详细信息
 */
async function getCustomerDetails(accessToken, devToken, customerId) {
    try {
        const result = await searchGoogleAds(accessToken, devToken, customerId,
            `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.auto_tagging_enabled FROM customer`
        );
        return result;
    } catch (e) {
        return { error: e.message };
    }
}

module.exports = {
    getAccessToken,
    callGoogleAdsApi,
    searchGoogleAds,
    createCampaign,
    createAdGroup,
    createAd,
    publishGoogleAds,
    listAccessibleCustomers,
    getCustomerDetails,
    microsFromAmount,
    amountFromMicros
};
