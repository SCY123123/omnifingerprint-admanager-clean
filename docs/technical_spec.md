# 技术文档 - 创建主页功能实现

## 1. 系统架构
该功能分为前端 UI 组件、后端 API 接口（云端存储服务）以及 Puppeteer 自动化脚本（本地客户端）三部分。

> **⚠️ 核心架构澄清：Puppeteer 作为本地客户端**
> `puppeteer-api-server.js` (Puppeteer 服务) **必须作为本地客户端程序**在用户本地环境运行，以唤起本地浏览器并注入防关联配置。
> **绝对不要**将其部署到云端服务器。云端只负责部署 `storage-api-server.js`。

> **⚠️ 构建排除规范：本地数据目录**
> `browser-profiles/` 目录包含本地浏览器的隔离数据、缓存和配置，**严禁参与前端构建**。构建系统必须完全忽略此目录，以确保构建效率和安全性。

## 2. 前端实现**🚫 构建排除规则 (Build Exclusion)**
> `browser-profiles/` 目录包含本地浏览器的隔离数据和缓存，**严禁**参与任何前端构建过程。
> 1. Tailwind 扫描器必须通过 `source(none)` 排除该目录。
> 2. Vite 配置文件必须显式忽略该目录的监听和打包。

## 2. 前端实现
### 2.1 组件设计
- **组件名称**：`PageCreator.tsx`
- **主要状态**：
  - `name`: 主页名称
  - `isRandomName`: 是否启用随机名称
  - `profileImage`: 头像文件
  - `backgroundImage`: 背景图文件
  - `website`: 关联网站
  - `category`: 主页类别
- **交互流程**：
  1. 用户在 `ProfileManager` 中选中配置，点击“批量操作” -> “创建主页”。
  2. 弹出 `PageCreator` 菜单。
  3. 用户填写信息并确认。
  4. 前端将图片转换为 Base64 格式，连同其他信息通过 `fetch` 发送到后端。

### 2.2 集成点
- 在 `ProfileManager.tsx` 中引入并使用 `PageCreator`。
- 使用 `runInChunks` 控制并发请求频率。

## 3. 后端实现
### 3.1 API 接口
- **端点**：`POST /api/facebook/pages/create`
- **端点**：`POST /api/facebook/autofill-login` (手动触发自动填充)
- **端点**：`POST /api/ai/chat` (AI 对话与自动化指令)
- **控制器**：`server/puppeteer-api-server.js` (自动填充), `server/storage-api-server.js` (AI 对话)

- **端点**：`POST /api/facebook/publish-ad` (发布广告)
- **控制器**：`server/puppeteer-api-server.js` (发布广告)

## 4. Facebook 广告发布自动化架构
- **发布模式**：
    1. **API 高速发布**：使用 Facebook Graph API 直接提交广告数据，支持全量参数配置（账户、主页、像素、受众细分、预算排期等）。
    2. **浏览器模拟发布**：使用 Puppeteer 模拟人工操作，适配新版 Ads Manager 界面。
- **Graph 请求链路**：
    1. 默认由 `callFacebookGraphApi` 使用系统 `curl` 执行请求，并支持代理解析、`spawn + stdin` 大素材上传。
    2. 若检测到系统网络对 `graph.facebook.com:443` 不可达，且当前 Profile 未配置代理，则自动切换到 `callFacebookGraphApiViaBrowser`，复用已启动浏览器的网络上下文执行 `fetch`。
    3. 浏览器回退需兼容 `Campaign -> AdSet -> Creative -> Ad` 全链路以及 `adimages` 素材上传，确保 API 模式不会因单一网络出口异常而整体失效。
    4. `adimages` 的浏览器回退必须将 `bytes` 作为原始 Base64 字符串提交，禁止在页内转换为 `Blob/File`，否则 Graph API 会返回 `Invalid parameter (100)`。
    5. 所有 Graph API 的数组或对象参数必须统一做 `JSON.stringify` 序列化后再提交，尤其是 `special_ad_categories`、`targeting`、`promoted_object`、`creative` 等字段，禁止直接按普通字符串透传。
- **全量参数支持（还原 FB Ads Manager 后台 100% 参数）**：

    ### Campaign 层级
    | 参数 | 字段 | 说明 |
    |------|------|------|
    | 系列名称 | `campaignName` | |
    | 广告目标 | `objective` | TRAFFIC / SALES / ENGAGEMENT / LEADS / AWARENESS / APP_PROMOTION / REACH / VIDEO_VIEWS / MESSAGES / CATALOG_SALES / STORE_VISITS |
    | 购买方式 | `buyingType` | AUCTION / RESERVED |
    | 特殊广告类别 | `specialAdCategories` | EMPLOYMENT / CREDIT / HOUSING / SOCIAL_ISSUES_ELECTIONS / GAMBLING / HEALTHCARE |
    | 预算层级 | `budgetLevel` | CAMPAIGN (CBO) / ADSET |
    | 预算类型 | `budgetType` | DAILY / LIFETIME |
    | 预算金额 | `budget` | USD |
    | Advantage+ 系列预算 | `advantageCampaignBudget` | |
    | 出价策略 | `bidStrategy` | LOWEST_COST_WITHOUT_CAP / LOWEST_COST_WITH_BID_CAP / COST_CAP / BID_CAP / TARGET_COST / ROAS |
    | 竞价/ROAS 金额 | `bidAmount` / `targetRoas` | |
    | 投放节奏 | `pacingType` | standard / no_pacing |
    | 转化归因窗口 | `conversionAttributionWindow` | 7种窗口选择 |
    | 品牌安全 | `brandSafety` / `brandSuitability` | standard / limited / strict |
    | 开始/结束日期 | `startDate` / `endDate` | |
    | 系列状态 | `campaignStatus` | ACTIVE / PAUSED |
    | 两步模式 | `autoActivate` | 先创建 PAUSED 再自动开启 |

    ### AdSet 层级
    | 参数 | 字段 | 说明 |
    |------|------|------|
    | 广告组名称 | `adSetName` | |
    | 优化目标 | `optimizationGoal` | LINK_CLICKS / IMPRESSIONS / REACH / VALUE / CONVERSIONS / LEAD_GENERATION / MESSAGES / THRUPLAY / POST_ENGAGEMENT / PAGE_LIKES 等 |
    | 国家/地区 | `countries` | ISO 格式，逗号分隔 |
    | 城市 | `cityTargeting` | 城市ID或名称 |
    | 地区/州 | `regionTargeting` | 地区ID |
    | 邮编 | `zips` | 逗号分隔 |
    | DMA 区域 | `dma` | DMA ID |
    | 辐射范围 | `radius` | 公里 |
    | 位置类型 | `locationType` | all / home / recent / traveling |
    | 排除位置 | `excludeLocations` | ISO 国家代码 |
    | 年龄范围 | `ageMin` / `ageMax` | 13-65 |
    | 性别 | `gender` | all / male / female |
    | 人生大事 | `lifeEvents` | NEW_JOB / NEWLY_MARRIED / NEW_BABY / RECENTLY_MOVED |
    | 家长身份 | `parents` | PARENTS / EXPECTANT_PARENTS |
    | 感情状态 | `relationshipStatus` | SINGLE / MARRIED |
    | 教育程度 | `education` | HIGH_SCHOOL / COLLEGE / GRAD_SCHOOL |
    | 大学 | `college` | 大学ID |
    | 收入 | `income` | 6个收入段 |
    | 住房状况 | `homeOwnership` | HOME_OWNERS / RENTERS |
    | 家庭构成 | `householdComposition` | CHILDREN_IN_HOUSEHOLD / NO_CHILDREN |
    | 族裔亲和 | `ethnicAffinity` | AFRICAN_AMERICAN / ASIAN_AMERICAN / HISPANIC |
    | 世代 | `generation` | GEN_Z / MILLENNIAL / GEN_X / BABY_BOOMER |
    | 数字活动 | `digitalActivities` | FREQUENT_SHOPPERS / MOBILE_ENTHUSIASTS |
    | 政治倾向 | `politics` | LIBERAL / MODERATE / CONSERVATIVE |
    | 雇主 | `workEmployer` | 雇主名称或ID |
    | 语言 | `languages` | FB 语言代码 |
    | 细分定位 | `detailedTargeting` | JSON 格式的兴趣/行为定位 |
    | 排除细分 | `detailedExclusions` | JSON 格式排除 |
    | 自定义受众(包含) | `customAudiencesInclude` | JSON 数组 |
    | 自定义受众(排除) | `customAudiencesExclude` | JSON 数组 |
    | 排除已赞用户 | `excludedConnections` | 主页/好友ID |
    | 好友扩展 | `friendsOfConnections` | |
    | 宽泛定位 | `broadTargeting` | |
    | Advantage+ 受众 | `enableAdvantageAudience` | |
    | 版位 | `placements` | automatic / manual |
    | 版位控制 | `placementsControl` | JSON/逗号分隔排除版位 |
    | 限制版位支出 | `allowLimitedSpendOnExcluded` | |
    | 设备平台 | `devicePlatforms` | mobile / desktop |
    | 操作系统 | `osType` | ios / android / all |
    | 设备型号 | `deviceModels` | 逗号分隔型号名 |
    | 运营商 | `carrierTargeting` | 逗号分隔 |
    | 网速 | `connectionSpeed` | any / LOW / MEDIUM / HIGH |
    | 仅 WiFi | `wifiOnly` | |
    | 广告组预算 | `budget` (AdSet级) | |
    | 成本上限 | `costCap` / `bidAmount` | |
    | 最低 ROAS | `minRoas` | |
    | 投放类型 | `deliveryType` | standard / accelerated |
    | 客户生命周期 | `customerLifecycle` | NEW / RETURNING / LOYAL / LAPSED |
    | 转化窗口 | `conversionWindow` | |
    | 归因方式 | `attributionSpec` | 7D_CLICK_1D_VIEW / 1D_CLICK_1D_VIEW / 7D_CLICK 等 |
    | 归因模型 | `attributionModel` | STANDARD / DATA_DRIVEN |
    | 推广对象(像素) | `pixel_id` | 自动匹配 |
    | 推广对象(主页) | `page_id` | 无像素时回退 |

    ### Ad 层级
    | 参数 | 字段 | 说明 |
    |------|------|------|
    | 广告名称 | `adName` | |
    | 广告格式 | `adFormat` | SINGLE_IMAGE_VIDEO / CAROUSEL / COLLECTION / INSTANT_EXPERIENCE / DYNAMIC |
    | 主要文案 | `adText` | |
    | 文案变体 | `adText2` | 动态创意A/B测试 |
    | 标题 | `headline` | |
    | 标题变体 | `headline2` | 动态创意A/B测试 |
    | 广告说明 | `adDescription` | |
    | 说明变体 | `adDescription2` | 动态创意A/B测试 |
    | 落地页 URL | `websiteUrl` | |
    | 显示链接 | `displayLink` / `useDisplayLink` | |
    | 深度链接 | `deepLink` | |
    | CTA 按钮 | `ctaType` | LEARN_MORE / SHOP_NOW / SIGN_UP / CONTACT_US 等 |
    | 自定义 CTA | `callToActionCustom` | |
    | 线索表单 ID | `leadFormId` | |
    | Messenger 欢迎语 | `messengerWelcomeMessage` | |
    | 互动类型 | `engagementType` | MESSAGES / PAGE_LIKES / POST_ENGAGEMENT |
    | 像素/转化事件 | `pixelIds` / `conversionEvent` | PURCHASE / LEAD / ADD_TO_CART 等 |
    | 产品目录 ID | `productCatalogId` | |
    | 产品集 ID | `productSetId` | |
    | 即时体验 ID | `instantExperienceId` | |
    | 优惠 ID | `offerId` / `offerDescription` | |
    | 网址参数 | `urlParams` | utm_source 等 |
    | Advantage+ 创意 | `enableAdvantageCreative` | |
    | 动态创意 | `enableDynamicCreative` | 多文案/多标题/多描述 |
    | 视频轮播 | `enableVO` | |
    | 广告状态 | `adStatus` | ACTIVE / PAUSED |

- **流程设计 (API 模式)**：
    1. 前端获取广告配置并选取发布模式。
    2. 后端自动识别账户与主页凭据。
    3. 构建分层级发布任务（Campaign -> AdSet -> Creative -> Ad）。
    4. 实时同步发布 ID 与执行状态至云端数据库。

- **后端参数映射 (`runFacebookPublishAdApi`)**:
    - 函数从 `campaignTree` 树形结构中提取所有参数（优先），回落至扁平 `data` 字段兼容旧模式。
    - 使用 `final*` 变量合并策略确保旧扁平字段有最高优先级。
    - 完整参数流程：`前端UI` → `handlePublishAdsConfirm(campaignTree)` → `POST /api/facebook/publish-ad` → `runFacebookPublishAdApi(req.body)` → `campaignTree[0]`

## 5. 数据库设计与迁移 (Database Design & Migrations)
### 5.1 配置表 (Profiles Table)
- **主要字段**：`id`, `ext_id`, `name`, `platform`, `account_name`, `account_email`, `account_password`, `account`, `proxy`, `account_status`, `seq`, `account_tokens` 等。
- **数据库文件名**：统一使用 `omnifingerprint.db`。
- **ext_id 字段**：用于兼容旧版数据标识。系统会自动分配新的自增 `id` (INTEGER PRIMARY KEY)。
- **platform 字段**：标识账号所属平台，如 `Meta (Facebook/Instagram)`。
- **account_tokens 字段**：存储 Facebook Graph API 访问令牌。

### 5.2 自动迁移机制
- **本地客户端 (Puppeteer API)**：在 `findProfileById` 逻辑中，启动时会自动检查 `profiles` 表结构。若缺失 `account_name` 字段，将通过 `ALTER TABLE` 自动添加，确保查询不报错。
- **存储后端 (Storage API)**：
    - 在 `ensureProfilesColumns` 函数中，系统会遍历 `profiles` 表的所有字段。
    - **自动补全**：若发现 `account_name`, `account_status`, `seq`, `ext_id`, `platform`, `account_tokens` 缺失，将自动执行 `ALTER TABLE` 补全。
    - **跨版本迁移**：若 `id` 字段类型为 `TEXT`（旧版设计），系统会自动执行“影子表迁移”：创建 `profiles_new` (以 INTEGER 为 ID)，将旧数据导入并重命名，确保与新版代码兼容。
- **原则**：同一数据库错误出现 2 次必须解决根本原因（通过自动迁移机制解决字段缺失问题）。

## 7. 部署与环境规范 (Deployment & Env Specs)
### 7.1 前端与全栈部署 (Cloudflare Pages)
- **架构升级**：项目已迁移至 Cloudflare Pages 全栈架构。前端托管在 Pages，后端逻辑由 Pages Functions (`functions/api/[[path]].js`) 提供。
- **数据库**：使用 Cloudflare D1 分布式 SQL 数据库作为核心存储。
- **项目实例**:
    - **Account ID**: `REPLACE_WITH_YOUR_CF_ACCOUNT_ID`
    - **Project Name**: `omnifingerprint-admanager`
    - **Production URL**: `https://your-project.pages.dev`
- **URL 规范**：
    - **数据库/通用 API**：使用**相对路径**（如 `/api/profiles`），由 Cloudflare Pages Functions 处理并访问 D1 数据库。
    - **Puppeteer/浏览器控制**：根据用户需求，直接请求**本地地址** `http://localhost:9999/api`。这要求用户浏览器允许对本地网络的访问。
- **CORS 与安全**：
    - 本地 Puppeteer 服务 (`puppeteer-api-server.js`) 已配置允许来自 `pages.dev` 域名的跨域请求，并启用了 `Access-Control-Allow-Private-Network` 支持。
    - AI 服务 (Gemini/DeepSeek) 密钥仍保留在服务端环境变量中，通过 `/api/ai/*` 进行安全转发。
- **环境变量**：
    - `LAUNCH_SERVER_URL`: 指向用户本地运行的 Puppeteer API Server 地址。
    - `DEEPSEEK_API_KEY`: DeepSeek AI 服务的密钥。
    - `GEMINI_API_KEY`: Google Gemini AI 服务的密钥。
- **构建配置**：`wrangler.toml` 定义了项目名称、兼容日期、输出目录及 D1 数据库绑定。

### 7.2 本地 Puppeteer 服务
- **职责**：仅负责浏览器实例管理、指纹注入及自动化操作。
- **部署**：必须在用户本地运行，监听 9999 端口。
- **安全**：
    - **云端鉴权转发**：所有控制指令必须通过 Cloudflare Pages Functions (`/api/puppeteer/*`) 转发，网关层实现了严格的 RBAC 校验，禁止越权操作他人浏览器。
    - **API 密钥校验**：本地服务启用 `PUPPETEER_API_SECRET` 校验。所有请求必须携带 `X-Api-Secret` 响应头，否则返回 401。
    - **API 响应脱敏**：后端 `[[path]].js` 引入 `sanitizeUser` 工具函数，在返回 `GET /api/users`, `GET /api/auth/me` 及登录响应前，强制移除 `password_hash` 和内部敏感字段。
    - **越权保护 (IDOR Protection)**：
        - `POST /api/profiles/bulk-save` 与 `POST /api/profiles` 使用 `ON CONFLICT ... DO UPDATE ... WHERE profiles.user_id = excluded.user_id` 机制，确保只有所有者能更新配置。
        - `POST /api/profiles/update-account-status` 强制在 `WHERE` 子句中校验 `user_id`。
        - `POST /api/adaccounts` 同步接口同样执行 `user_id` 归属校验。
    - **Graph 代理安全**：`/api/graph` 接口现在强制要求 `Authorization` 响应头，并仅限已登录用户使用。
    - **Cookie 同步安全**：
        - **HTTPS 强制**：所有同步请求强制使用 HTTPS 协议，防止 Cookie 明文暴露。
        - **令牌转发**：本地服务在启动浏览器时捕获云端 JWT 令牌，并在同步 Cookie 时原样转发回云端 API，实现闭环鉴权。
        - **归属校验**：云端同步接口会二次核验配置的 `user_id` 与令牌中的 `uId` 是否匹配，确保 Cookie 只能同步到所有者名下。
    - **PNA 支持**：本地服务配置了 `Access-Control-Allow-Private-Network` 支持，允许 HTTPS 页面访问本地 HTTP 服务。

## 8. API 代理与安全性
- **Puppeteer 代理**：所有 `/api/puppeteer/*` 的请求被转发至 `LAUNCH_SERVER_URL`。
- **AI 代理**：Gemini 和 DeepSeek 的 API Key 存储在 Cloudflare 环境变量中，前端通过后端接口调用，确保密钥不泄露给客户端。
- **Graph 代理**：`/api/graph` 用于转发前端对 Facebook Graph API 的请求，绕过浏览器跨域限制。

## 9. 多级团队与 RBAC 实现
### 9.1 权限模型
- **SuperAdmin**：绕过所有 `user_id` 过滤，查询全量数据。
- **Admin / Full Permission**：
    - 逻辑：`WHERE user_id = {TeamRootID} OR user_id IN (SELECT id FROM users WHERE parent_id = {TeamRootID})`
    - `TeamRootID` 定义：若用户 `parent_id` 为空，则为其自身 `id`；否则为其 `parent_id`。
    - 适用角色：`role = 'admin'` 或 `permission_level = 'full'` 的用户。
- **User (Self Permission)**：
    - 逻辑：`WHERE user_id = {uId}`
    - 适用角色：`permission_level = 'own'` (或除 `full` 以外的其他值) 且非 `admin` 的普通用户。

### 9.2 数据库扩展
- **users 表**：新增 `parent_id` (归属上级), `role` (角色), `permission_level` (权限层级), `subscription_expires_at` (订阅到期时间)。
- **业务数据表**：`profiles`, `ad_accounts`, `pages`, `adpos_transactions` 等核心表均包含 `user_id` 字段。

### 9.3 核心业务逻辑
- **注册**：`POST /api/auth/register` 默认插入 `role = 'admin'`, `permission_level = 'full'`, `status = 'active'`。
- **团队添加**：`POST /api/users/add-member` 支持按邮箱邀请，并可选指定 `role`。
- **用户编辑**：`PUT /api/users/:id` 支持更新基本信息、角色、状态、权限层级及订阅到期时间。后端实现了灵活的字段映射，若密码为空则不执行更新。
- **数据查询**：所有 `GET` 请求在执行 SQL 前会先查询当前用户的 `parent_id` 和 `permission_level`，以确定过滤范围。
- **分享路由优先级**：`POST /api/profiles/share` 必须先于或独立于 `/api/profiles/:id` 通配详情路由处理；详情路由必须限制为 `GET`，否则会把分享请求误识别为读取 `id = share` 的配置，前端出现“显示成功但数据库未写入”的假成功。

### 9.4 鉴权流程
1. 前端登录后获取 JWT 格式 Token（包含 `id`, `username`, `role`）。
2. Pages Functions 拦截请求，解析 Token 并提取用户信息。
3. 根据角色动态拼接 SQL 过滤语句。
4. 创建资源（如 Profile）时，后端强制注入当前操作者的 `user_id`。

## 6. 性能与稳定性优化 (Performance & Stability Optimizations)

### 6.1 非阻塞启动架构 (Non-blocking Launch Architecture)
- **解耦设计**：将“浏览器进程启动”与“页面初始化（Cookie 注入、导航、自动填充）”解耦。
- **即时响应**：API 在浏览器进程成功开启后立即返回成功，耗时的网络任务移至后台异步执行。
- **效果**：解决启动队列因单个页面加载慢而导致的“卡在一般”或“启动缓慢”问题，确保 UI 响应零延迟。

### 6.2 并发控制 (Concurrency Control)
- **LaunchQueueManager**：引入启动队列管理器，限制物理进程的瞬时启动并发数。
- **并发阈值**：`MAX_CONCURRENT_LAUNCHES` 设置为 3。该数值在保证不产生端口冲突和系统资源过载的前提下，最大化并行启动效率。
- **自动分配端口**：从 9222 开始动态探测并分配空闲 CDP 端口。

### 6.3 网络任务弹性处理
- **Cookie 注入超时**：为 `page.setCookie` 包装 `Promise.race`，设置 15 秒强制超时，防止因代理不稳定导致的永久挂起。
- **导航策略**：`page.goto` 等待策略使用 `networkidle2`，并设置 60 秒全局超时。

## 10. 私有永久邮箱系统实现 (Private Email System Implementation)
### 10.1 核心逻辑与组件
- **组件名称**：`EmailSystem.tsx` (V4.0.9+)
- **架构分离**：
    - 抛弃第三方 Mail.tm 等不稳定 API。
    - **Email Worker** (`email-worker/src/index.js`) 独立部署，专门处理 Cloudflare Email Routing 触发器，解析邮件直接写入 D1 数据库。
    - **Pages API** (`/api/private-emails/list`) 提供前端查询接口，连接至同一个 D1 数据库。
    - **地址列表 API** (`/api/private-emails/addresses`)：通过 `GROUP BY address` 聚合查询，获取每个地址的 `MIN(created_at)` 作为创建时间，用于侧边栏展示。
- **无密码体系**：通过私有域名（构建时配置的收信域名），任何地址直接接收并读取，不依赖密码验证。
- **UI 布局优化**：
    - **三栏式架构**：UI 升级为三栏布局：左侧“地址侧边栏”、中间“邮件列表”、右侧“详情视图”。
    - **混合数据源**：左侧侧边栏在私有模式下由 `/api/private-emails/addresses` 驱动，在公共模式下由本地 `localStorage` 历史记录驱动，均包含创建时间戳。
    - **自适应切换**：支持点击地址即时切换数据流，无需重新加载组件。
- **历史记录智能切换**：修复第三方域名（如 oakon.com）下架导致的切换失败，活跃地址在 UI 中直接支持点击修改。

## 11. TikTok Ads 自动化注册实现 (TikTok Ads Automation)
### 11.1 前端交互与 API 设计
- **组件**：`TikTokRegistration.tsx` (V5.0.8+)
- **交互逻辑**：通过接收 `selectedProfileIds`，智能渲染“批量新建”模式或“为选中的 N 个环境启动注册”模式。
- **API 接口**：`POST http://localhost:9999/api/tiktok/batch-register`
  - 携带 `X-Api-Secret` 跨域请求本地服务。
  - 参数：`count`（新建数量），`profileIds`（选中的现有环境 ID 数组）。

### 11.2 后端 Puppeteer 逻辑 (`puppeteer-api-server.js`)
- **数据流转**：
  - 未传 `profileIds`：通过 Mail.tm API 新建公共邮箱账号，若失败则回退至自建收信域名。
  - 传了 `profileIds`：读取本地存储配置，若无账号邮箱则自动补充公共邮箱。
- **自动化流转 (`runTikTokRegistration`)**：
  - 目标：`https://ads.tiktok.com/i18n/signup/`
  - 逻辑：
    - 自动填写 `input[name="email"]` 和 `input[name="password"]`。
    - 点击 `.ac-sendcode-input__btn` 发送验证码。
    - 轮询获取最新验证码：
      - 公共邮箱模式：调用 Mail.tm API (`/messages`)。
      - 私有邮箱模式：调用 Pages API (`/api/private-emails/list`)。
    - 自动填充 `input[name="code"]` 并勾选协议条款。
    - **多维度协议勾选实现**：
      - **策略 A (DOM)**：遍历 `.bui-checkbox` 容器及包含 "Terms of Service" 文本的 Label，通过事件派发 (`click`, `mousedown`, `mouseup`) 触发勾选。
      - **策略 B (物理坐标)**：计算协议文本相对于视口的坐标，并向左偏移（通常为图标位置）执行 `page.mouse.click`。
      - **策略 C (键盘补偿)**：从密码框出发，执行多次 `Tab` + `Space` 操作，覆盖所有可能的交互元素。
      - **兜底强制激活**：若注册按钮仍为 `disabled`，通过 JS 强行移除禁用属性及相关类名 (`is-disabled`, `bui-btn-disabled`)。
    - **数据闭环同步逻辑**：
      - **注册后登录检测**：提交注册后，脚本会自动等待并检测页面跳转。若重定向至登录页，则自动使用新注册的账号执行登录。
      - **状态验证**：验证是否成功进入 `dashboard` 或 `business` 页面。
      - **全量同步**：在确认登录状态后，调用 `page.cookies()` 提取全量 Cookie。
      - **数据回写**：通过 `PUT /api/profiles/:id` 接口，将 `account_email`、`account_password`、`account_cookies` 及 `account_status` (Active) 同步回 Cloudflare D1 数据库。
    - 点击提交注册按钮（支持多种选择器：`button[type="submit"]`, `.ac-signup-submit-btn` 等）。
    - 自动截图保存至 `server/logs/screenshots` 目录。
