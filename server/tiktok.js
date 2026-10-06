'use strict';

const path = require('path');

// ============================================================
// 🎯 TikTok 广告批量发布
// ============================================================

// 📋 注入的依赖
let _log = () => {};
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _ensureBrowserIsRunning = async () => ({ success: false, error: '__inject not called' });
let _APP_ROOT = '';
let _app = null;

// 📋 任务存储
const tiktokTasks = new Map();

// 🆔 生成任务ID
function genTaskId() {
    return 'tk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 📋 注册路由
function registerRoutes() {
    // 📋 获取任务状态
    _app.get('/api/tiktok/tasks-status', async (req, res) => {
        try {
            const { ids } = req.query;
            let tasks = [];
            if (ids) {
                const idList = ids.split(',').filter(Boolean);
                tasks = idList.map(id => tiktokTasks.get(id)).filter(Boolean);
            } else {
                // 返回最近的20个任务
                const allTasks = Array.from(tiktokTasks.entries())
                    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
                    .slice(0, 20)
                    .map(([_, v]) => v);
                tasks = allTasks;
            }
            res.json({ success: true, tasks });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 📋 TikTok 批量注册 (已存在前端调用, 补充后端实现)
    _app.post('/api/tiktok/batch-register', async (req, res) => {
        const { count = 1, profileIds, captchaKey } = req.body;
        _log('INFO', `🎯 TikTok 批量注册请求: count=${count}, profileIds=${profileIds?.length || 0}`);

        try {
            const tasks = [];
            const actualCount = profileIds?.length || count;

            for (let i = 0; i < actualCount; i++) {
                const taskId = genTaskId();
                const task = {
                    id: taskId,
                    profileId: profileIds?.[i] || null,
                    profileName: null,
                    email: null,
                    status: 'pending',
                    error: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                tiktokTasks.set(taskId, task);
                tasks.push(task);
            }

            // 异步执行注册任务
            tasks.forEach(task => {
                const profileId = task.profileId;
                runTikTokRegistration(profileId, task.id, captchaKey).catch(err => {
                    _log('ERROR', `❌ TikTok注册任务 ${task.id} 失败: ${err.message}`);
                    const t = tiktokTasks.get(task.id);
                    if (t) { t.status = 'error'; t.error = err.message; t.updatedAt = Date.now(); }
                });
            });

            res.json({ success: true, tasks, message: `已启动 ${tasks.length} 个注册任务` });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // 🎯 TikTok 广告发布
    _app.post('/api/tiktok/ads/publish', async (req, res) => {
        const {
            profileIds,           // 要发布的Profile ID列表
            campaignName,         // 广告系列名称
            adGroupName,          // 广告组名称
            adName,               // 广告名称
            objective,            // 推广目标: TRAFFIC | CONVERSIONS | REACH | VIDEO_VIEWS | LEAD_GENERATION
            budget,               // 预算 (USD)
            budgetType,           // DAILY | LIFETIME
            startDate,            // 开始日期 YYYY-MM-DD
            endDate,              // 结束日期 YYYY-MM-DD
            mediaBase64,          // 素材Base64 (支持图片/视频)
            mediaType,            // image | video
            adText,               // 广告文案
            callToAction,         // CTA: Learn More | Shop Now | Sign Up | Contact Us | Download
            websiteUrl,           // 落地页URL
            displayName,          // 显示名称
            countries,            // 投放国家 ISO 逗号分隔
            gender,               // all | male | female
            ageMin,               // 最小年龄
            ageMax,               // 最大年龄
            placementTypes,       // 版位: feed | story | in_feed | etc
            optimizationGoal,     // 优化目标
            publishMethod         // api | puppeteer
        } = req.body;

        const ids = Array.isArray(profileIds) ? profileIds : [profileIds].filter(Boolean);
        if (!ids || ids.length === 0) {
            return res.status(400).json({ success: false, message: '请至少选择一个发布环境' });
        }

        _log('INFO', `🎯 TikTok 广告发布请求: Profiles=${ids.length}, Campaign=${campaignName}, Method=${publishMethod || 'puppeteer'}`);

        try {
            const tasks = ids.map(pid => ({
                id: genTaskId(),
                profileId: pid,
                status: 'pending',
                message: '排队中',
                createdAt: Date.now(),
                updatedAt: Date.now()
            }));

            // 保存任务
            tasks.forEach(t => tiktokTasks.set(t.id, t));

            // 异步执行发布
            tasks.forEach(task => {
                runTikTokAdPublish(task.profileId, task.id, req.body).catch(err => {
                    _log('ERROR', `❌ TikTok广告发布任务 ${task.id} 失败: ${err.message}`);
                    const t = tiktokTasks.get(task.id);
                    if (t) { t.status = 'error'; t.message = err.message; t.updatedAt = Date.now(); }
                });
            });

            res.json({ success: true, tasks, message: `已启动 ${tasks.length} 个广告发布任务` });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });
}

// ============================================================
// 🎯 TikTok 核心自动化函数
// ============================================================

/**
 * TikTok 广告自动发布函数
 * 通过 Puppeteer 自动化在 ads.tiktok.com 创建广告
 */
async function runTikTokAdPublish(profileId, taskId, config) {
    const task = tiktokTasks.get(taskId);
    if (!task) return;

    const updateTask = (status, msg) => {
        const t = tiktokTasks.get(taskId);
        if (t) { t.status = status; t.message = msg; t.updatedAt = Date.now(); }
    };

    updateTask('running', '正在启动浏览器...');

    try {
        // 1. 确保浏览器运行
        const bResult = await _ensureBrowserIsRunning(profileId);
        if (!bResult.success) throw new Error(bResult.error || '无法启动浏览器');

        const browserData = bResult.browserData;
        const browser = browserData.browser;
        const pages = await browser.pages();
        let page = pages.find(p => /ads\.tiktok\.com/i.test(p.url())) || pages[0] || await browser.newPage();

        // 2. 导航到TikTok Ads Manager
        updateTask('running', '正在打开TikTok广告管理平台...');
        await page.goto('https://ads.tiktok.com/', { waitUntil: 'networkidle2', timeout: 60000 });
        await _sleep(3000);

        // 3. 检查登录状态
        const currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('auth')) {
            updateTask('error', '请先在浏览器中登录TikTok Ads账号');
            throw new Error('TikTok Ads 未登录，请先在浏览器中登录');
        }

        updateTask('running', '已登录TikTok Ads，正在进入广告创建流程...');

        // 4. 导航到广告创建页面 - 尝试直接打开创建广告的URL
        await page.goto('https://ads.tiktok.com/i18n/ad_form/', { waitUntil: 'networkidle2', timeout: 60000 });
        await _sleep(3000);

        // 5. 检查页面是否正常加载
        const pageTitle = await page.title();
        _log('INFO', `[TikTok Ad] 页面标题: ${pageTitle}`);

        // 6. 如果页面加载异常，尝试通过资产管理进入
        if (pageTitle.includes('404') || pageTitle.includes('not found')) {
            await page.goto('https://ads.tiktok.com/i18n/campaign/dashboard/', { waitUntil: 'networkidle2', timeout: 60000 });
            await _sleep(3000);

            // 尝试点击"创建"按钮
            try {
                const createBtnSelectors = [
                    'button:has-text("Create")',
                    'button:has-text("创建")',
                    '[data-testid="create-btn"]',
                    '.create-btn',
                    'a[href*="ad_form"]',
                    'button:has-text("New")',
                    'button:has-text("新建")'
                ];
                for (const sel of createBtnSelectors) {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        await _sleep(2000);
                        break;
                    }
                }
            } catch (e) {
                _log('WARN', `[TikTok Ad] 点击创建按钮失败: ${e.message}`);
            }
        }

        await _sleep(2000);

        // 7. 填写广告系列信息
        updateTask('running', '正在填写广告系列信息...');

        // 选择推广目标
        if (config.objective) {
            const objectiveMap = {
                'TRAFFIC': 'Traffic',
                'CONVERSIONS': 'Conversions',
                'REACH': 'Reach',
                'VIDEO_VIEWS': 'Video Views',
                'LEAD_GENERATION': 'Lead Generation'
            };
            const objLabel = objectiveMap[config.objective] || config.objective;
            try {
                // 点击目标选择区域
                const objectiveSelectors = [
                    `[data-value="${config.objective}"]`,
                    `text="${objLabel}"`,
                    `span:has-text("${objLabel}")`,
                    `div:has-text("${objLabel}")`
                ];
                for (const sel of objectiveSelectors) {
                    const el = await page.$(sel);
                    if (el) {
                        await el.click();
                        await _sleep(1000);
                        break;
                    }
                }
            } catch (e) {
                _log('WARN', `[TikTok Ad] 选择目标失败: ${e.message}`);
            }
        }

        await _sleep(1500);

        // 填写广告系列名称
        if (config.campaignName) {
            try {
                const nameInput = await page.$('input[placeholder*="campaign" i], input[placeholder*="系列" i], input[name*="campaign" i]');
                if (nameInput) {
                    await nameInput.click({ clickCount: 3 });
                    await nameInput.type(config.campaignName, { delay: 30 });
                }
            } catch (e) {
                _log('WARN', `[TikTok Ad] 填写系列名称失败: ${e.message}`);
            }
        }

        // 填写预算
        if (config.budget) {
            try {
                const budgetInput = await page.$('input[placeholder*="budget" i], input[placeholder*="预算" i], input[name*="budget" i], input[type="number"]');
                if (budgetInput) {
                    await budgetInput.click({ clickCount: 3 });
                    await budgetInput.type(String(config.budget), { delay: 20 });
                }
            } catch (e) {
                _log('WARN', `[TikTok Ad] 填写预算失败: ${e.message}`);
            }
        }

        await _sleep(1000);

        // 8. 点击"下一步"或"Continue"
        updateTask('running', '正在提交广告系列设置...');
        try {
            const nextBtnSelectors = [
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button:has-text("下一步")',
                'button:has-text("继续")',
                'button[type="submit"]',
                '.next-btn',
                '[data-testid="next-btn"]'
            ];
            for (const sel of nextBtnSelectors) {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    await _sleep(3000);
                    break;
                }
            }
        } catch (e) {
            _log('WARN', `[TikTok Ad] 点击下一步失败: ${e.message}`);
        }

        // 9. 设置广告组（投放定向）
        updateTask('running', '正在设置广告组定向...');

        // 填写广告组名称
        if (config.adGroupName) {
            try {
                const agInput = await page.$('input[placeholder*="ad group" i], input[placeholder*="广告组" i], input[name*="adgroup" i]');
                if (agInput) {
                    await agInput.click({ clickCount: 3 });
                    await agInput.type(config.adGroupName, { delay: 30 });
                }
            } catch (e) {}
        }

        // 设置国家/地区
        if (config.countries) {
            try {
                const countryInput = await page.$('input[placeholder*="country" i], input[placeholder*="location" i], input[placeholder*="地区" i]');
                if (countryInput) {
                    await countryInput.click();
                    await _sleep(500);
                    const countries = config.countries.split(',').map(c => c.trim());
                    for (const country of countries) {
                        await countryInput.type(country, { delay: 50 });
                        await _sleep(500);
                        // 尝试选择第一个选项
                        const option = await page.$('.option-item:first-child, [data-testid*="option"]:first-child, li:first-child');
                        if (option) {
                            await option.click();
                            await _sleep(300);
                        }
                    }
                }
            } catch (e) {}
        }

        // 设置年龄范围
        if (config.ageMin || config.ageMax) {
            try {
                const ageFrom = await page.$('input[placeholder*="min" i], input[placeholder*="from" i], input[name*="age_from" i], input[name*="age_min" i]');
                if (ageFrom && config.ageMin) {
                    await ageFrom.click({ clickCount: 3 });
                    await ageFrom.type(String(config.ageMin), { delay: 20 });
                }
                const ageTo = await page.$('input[placeholder*="max" i], input[placeholder*="to" i], input[name*="age_to" i], input[name*="age_max" i]');
                if (ageTo && config.ageMax) {
                    await ageTo.click({ clickCount: 3 });
                    await ageTo.type(String(config.ageMax), { delay: 20 });
                }
            } catch (e) {}
        }

        // 设置性别
        if (config.gender && config.gender !== 'all') {
            try {
                const genderLabels = config.gender === 'male' ? ['Male', '男性'] : ['Female', '女性'];
                for (const label of genderLabels) {
                    const genderEl = await page.$(`text="${label}"`);
                    if (genderEl) {
                        await genderEl.click();
                        break;
                    }
                }
            } catch (e) {}
        }

        await _sleep(1000);

        // 10. 进入广告创意设置
        updateTask('running', '正在进入广告创意设置...');
        try {
            for (const sel of nextBtnSelectors) {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    await _sleep(3000);
                    break;
                }
            }
        } catch (e) {}

        // 11. 填写广告创意
        updateTask('running', '正在填写广告创意...');

        // 上传素材
        if (config.mediaBase64) {
            try {
                const fileInput = await page.$('input[type="file"]');
                if (fileInput) {
                    // 将Base64转换为Buffer并上传
                    const matches = config.mediaBase64.match(/^data:(.+);base64,(.+)$/);
                    if (matches) {
                        const mimeType = matches[1];
                        const ext = mimeType.includes('video') ? '.mp4' : '.jpg';
                        const buffer = Buffer.from(matches[2], 'base64');
                        const filePath = path.join(_APP_ROOT, 'logs', `tiktok_upload_${taskId}${ext}`);
                        require('fs').writeFileSync(filePath, buffer);
                        await fileInput.uploadFile(filePath);
                        await _sleep(3000);
                        // 清理临时文件
                        try { require('fs').unlinkSync(filePath); } catch {}
                    }
                }
            } catch (e) {
                _log('WARN', `[TikTok Ad] 上传素材失败: ${e.message}`);
            }
        }

        // 填写广告名称
        if (config.adName) {
            try {
                const adNameInput = await page.$('input[placeholder*="ad name" i], input[placeholder*="广告名称" i], input[name*="ad_name" i]');
                if (adNameInput) {
                    await adNameInput.click({ clickCount: 3 });
                    await adNameInput.type(config.adName, { delay: 30 });
                }
            } catch (e) {}
        }

        // 填写广告文案
        if (config.adText) {
            try {
                const textArea = await page.$('textarea[placeholder*="ad text" i], textarea[placeholder*="广告文案" i], textarea[placeholder*="text" i], div[contenteditable="true"]');
                if (textArea) {
                    await textArea.click();
                    await textArea.type(config.adText, { delay: 15 });
                }
            } catch (e) {}
        }

        // 填写落地页URL
        if (config.websiteUrl) {
            try {
                const urlInput = await page.$('input[placeholder*="https://" i], input[placeholder*="website" i], input[placeholder*="URL" i], input[name*="website" i], input[name*="url" i]');
                if (urlInput) {
                    await urlInput.click({ clickCount: 3 });
                    await urlInput.type(config.websiteUrl, { delay: 20 });
                }
            } catch (e) {}
        }

        // 选择CTA
        if (config.callToAction) {
            try {
                const ctaSelectors = [
                    `button:has-text("${config.callToAction}")`,
                    `[data-value="${config.callToAction}"]`,
                    `option[value="${config.callToAction}"]`
                ];
                for (const sel of ctaSelectors) {
                    const el = await page.$(sel);
                    if (el) {
                        await el.click();
                        await _sleep(500);
                        break;
                    }
                }
            } catch (e) {}
        }

        await _sleep(2000);

        // 12. 提交广告
        updateTask('running', '正在提交广告...');
        try {
            const submitSelectors = [
                'button:has-text("Submit")',
                'button:has-text("Submit Ads")',
                'button:has-text("提交")',
                'button:has-text("发布")',
                'button:has-text("Publish")',
                'button:has-text("Launch")',
                'button:has-text("启动")',
                'button[type="submit"]:has-text("Submit")',
                '.submit-btn',
                '[data-testid="submit-btn"]'
            ];
            for (const sel of submitSelectors) {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    await _sleep(3000);
                    break;
                }
            }
        } catch (e) {
            _log('WARN', `[TikTok Ad] 提交广告失败: ${e.message}`);
            updateTask('warning', '无法自动提交，请在浏览器中手动完成');
        }

        // 13. 等待提交结果
        await _sleep(2000);

        // 检查是否提交成功
        const finalUrl = page.url();
        const isSuccess = finalUrl.includes('dashboard') || finalUrl.includes('campaign') || finalUrl.includes('manage');

        if (isSuccess) {
            updateTask('success', '广告发布成功');
            _log('SUCCESS', `✅ [TikTok Ad] Profile=${profileId} 广告发布成功`);
        } else {
            updateTask('warning', '广告已填写，请手动检查提交状态');
            _log('INFO', `[TikTok Ad] Profile=${profileId} 广告提交状态待确认`);
        }

    } catch (error) {
        _log('ERROR', `❌ [TikTok Ad] Profile=${profileId} 异常: ${error.message}`);
        updateTask('error', error.message);
    }
}

/**
 * TikTok 批量注册自动化 (补充实现)
 */
async function runTikTokRegistration(profileId, taskId, captchaKey) {
    const task = tiktokTasks.get(taskId);
    if (!task) return;

    const updateTask = (status, msg) => {
        const t = tiktokTasks.get(taskId);
        if (t) { t.status = status; t.message = msg; t.updatedAt = Date.now(); }
    };

    updateTask('running', '正在启动浏览器...');

    try {
        const bResult = await _ensureBrowserIsRunning(profileId);
        if (!bResult.success) throw new Error(bResult.error || '无法启动浏览器');

        const browserData = bResult.browserData;
        const browser = browserData.browser;
        const pages = await browser.pages();
        let page = pages[0] || await browser.newPage();

        // 导航到TikTok注册页面
        updateTask('running', '正在打开TikTok注册页面...');
        await page.goto('https://ads.tiktok.com/i18n/signup/', { waitUntil: 'networkidle2', timeout: 60000 });
        await _sleep(3000);

        // 更新任务状态为完成 (简化版注册)
        updateTask('success', '浏览器已打开到注册页面');
        _log('SUCCESS', `✅ [TikTok Register] Profile=${profileId} 已打开注册页面`);

    } catch (error) {
        _log('ERROR', `❌ [TikTok Register] Profile=${profileId} 异常: ${error.message}`);
        updateTask('error', error.message);
    }
}

/**
 * 注入主文件的依赖到 TikTok 模块
 */
function __inject(deps) {
    if (deps.log) _log = deps.log;
    if (deps.sleep) _sleep = deps.sleep;
    if (deps.ensureBrowserIsRunning) _ensureBrowserIsRunning = deps.ensureBrowserIsRunning;
    if (deps.APP_ROOT !== undefined) _APP_ROOT = deps.APP_ROOT;
    if (deps.app) {
        _app = deps.app;
        registerRoutes();
    }
}

module.exports = {
    __inject,
    tiktokTasks,
    genTaskId,
    runTikTokAdPublish,
    runTikTokRegistration
};
