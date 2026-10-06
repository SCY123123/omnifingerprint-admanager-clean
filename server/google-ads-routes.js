'use strict';

// ============================================================================
// Google Ads Routes - extracted from puppeteer-api-server.js
// ============================================================================

const googleAdsService = require('./google-ads-service');

// Injected variables
let _log = () => {};
let _app = null;

function __inject(deps) {
  if (deps.log) _log = deps.log;
  if (deps.app) _app = deps.app;
}

const log = (...args) => _log(...args);

// ════════════════════════════════════════════════════════════════
// Google Ads 批量发布广告
// ════════════════════════════════════════════════════════════════

/**
 * 获取 Google Ads 凭证（从系统设置环境变量）
 */
function getGoogleAdsCredentials() {
    return {
        clientId: process.env.GOOGLE_ADS_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || '',
        refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN || '',
        developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
        customerId: process.env.GOOGLE_ADS_CUSTOMER_ID || ''
    };
}

function registerRoutes() {
  if (!_app) return;

  /**
   * POST /api/google-ads/list-accounts
   * 列出可访问的 Google Ads 账户
   */
  _app.post('/api/google-ads/list-accounts', async (req, res) => {
      try {
          const { clientId, clientSecret, refreshToken, developerToken } = req.body;
          const cid = clientId || process.env.GOOGLE_ADS_CLIENT_ID;
          const csec = clientSecret || process.env.GOOGLE_ADS_CLIENT_SECRET;
          const rt = refreshToken || process.env.GOOGLE_ADS_REFRESH_TOKEN;
          const dt = developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
          if (!cid || !csec || !rt || !dt) {
              return res.status(400).json({ success: false, message: '缺少 Google Ads API 凭证，请在系统设置中配置' });
          }
          const accessToken = await googleAdsService.getAccessToken(cid, csec, rt);
          const result = await googleAdsService.listAccessibleCustomers(accessToken, dt);
          const customerIds = (result.resourceNames || []).map(rn => {
              const parts = rn.split('/');
              return parts[parts.length - 1];
          });
          // 获取每个客户的详细信息
          const customers = [];
          for (const cid2 of customerIds) {
              const details = await googleAdsService.getCustomerDetails(accessToken, dt, cid2);
              customers.push({ customerId: cid2, details: details.results?.[0]?.customer || {} });
          }
          return res.json({ success: true, customers, raw: result });
      } catch (e) {
          log('ERROR', `Google Ads 列出账户失败: ${e.message}`);
          return res.status(500).json({ success: false, message: e.message });
      }
  });

  /**
   * POST /api/google-ads/publish-ad
   * 批量发布 Google Ads 广告
   */
  _app.post('/api/google-ads/publish-ad', async (req, res) => {
      try {
          const { campaignTree, profileId, clientId, clientSecret, refreshToken, developerToken, customerId } = req.body;
          const cid = clientId || process.env.GOOGLE_ADS_CLIENT_ID;
          const csec = clientSecret || process.env.GOOGLE_ADS_CLIENT_SECRET;
          const rt = refreshToken || process.env.GOOGLE_ADS_REFRESH_TOKEN;
          const dt = developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
          const custId = customerId || process.env.GOOGLE_ADS_CUSTOMER_ID;
          if (!cid || !csec || !rt || !dt || !custId) {
              return res.status(400).json({ success: false, message: '缺少 Google Ads 凭证或客户 ID' });
          }
          if (!campaignTree || !campaignTree.length) {
              return res.status(400).json({ success: false, message: '缺少广告系列数据' });
          }
          log('INFO', `📢 Google Ads 开始发布: ${campaignTree.length} 个系列`);
          const accessToken = await googleAdsService.getAccessToken(cid, csec, rt);
          const result = await googleAdsService.publishGoogleAds(accessToken, dt, custId, campaignTree);
          log('INFO', `✅ Google Ads 发布完成`);
          return res.json({ success: true, message: `成功创建 ${result.campaigns.length} 个广告系列`, result });
      } catch (e) {
          log('ERROR', `Google Ads 发布失败: ${e.message}`);
          return res.status(500).json({ success: false, message: e.message });
      }
  });

  /**
   * GET /api/google-ads/credentials
   * 获取当前 Google Ads 凭证状态（不含密钥）
   */
  _app.get('/api/google-ads/credentials', (req, res) => {
      const creds = getGoogleAdsCredentials();
      return res.json({
          success: true,
          configured: !!(creds.clientId && creds.clientSecret && creds.refreshToken && creds.developerToken && creds.customerId),
          clientId: creds.clientId ? creds.clientId.substring(0, 20) + '...' : '',
          customerId: creds.customerId || ''
      });
  });

  // ════════════════════════════════════════════════════════════════
  // Google Ads 查询 API（资产列表）
  // ════════════════════════════════════════════════════════════════

  /**
   * POST /api/google-ads/query
   * 执行 GAQL 查询
   */
  _app.post('/api/google-ads/query', async (req, res) => {
      try {
          const { query, customerId, clientId, clientSecret, refreshToken, developerToken } = req.body;
          const cid = clientId || process.env.GOOGLE_ADS_CLIENT_ID;
          const csec = clientSecret || process.env.GOOGLE_ADS_CLIENT_SECRET;
          const rt = refreshToken || process.env.GOOGLE_ADS_REFRESH_TOKEN;
          const dt = developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
          const custId = customerId || process.env.GOOGLE_ADS_CUSTOMER_ID;
          if (!cid || !csec || !rt || !dt || !custId) {
              return res.status(400).json({ success: false, message: '缺少 Google Ads 凭证' });
          }
          if (!query) return res.status(400).json({ success: false, message: '缺少查询语句' });
          const accessToken = await googleAdsService.getAccessToken(cid, csec, rt);
          const result = await googleAdsService.searchGoogleAds(accessToken, dt, custId, query);
          return res.json({ success: true, results: result.results || [], totalResultsCount: result.totalResultsCount || 0 });
      } catch (e) {
          log('ERROR', `Google Ads 查询失败: ${e.message}`);
          return res.status(500).json({ success: false, message: e.message });
      }
  });
}

module.exports = { __inject, registerRoutes };
