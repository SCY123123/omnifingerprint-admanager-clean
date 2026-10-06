# OmniFingerprint AdManager 部署指南

本文档描述了如何将前端构建产物及云端后端（`baota-backend/`）部署到生产服务器（宝塔面板 Linux 服务器）。

## 整体架构

| 组件 | 运行位置 | 说明 |
|---|---|---|
| 前端静态页 | 服务器 `$DEPLOY_REMOTE_ROOT/web` | `npm run build` 产物，由 Nginx 托管 |
| 云端后端 | `baota-backend/` → 服务器站点目录（含 `api/ src/ sql/`） | Node + MySQL，监听 `127.0.0.1:7700`，外网由 Nginx 反代 443 |
| 本地 PUP Server | 用户本机 `server/puppeteer-api-server.js` | 浏览器自动化客户端，**不需要也不应该部署到云端** |
| Email Worker | Cloudflare Worker（`email-worker/`） | 临时邮箱收信后回调云端 `/api/private-emails/ingest` |

> **⚠️ 重要架构说明：Puppeteer 是本地客户端程序**
> 本项目中的 `puppeteer-api-server.js`（Puppeteer 服务）作为本地客户端运行，负责在用户本地环境控制浏览器和执行自动化操作。
> 线上服务器仅需部署前端静态页面和云端后端 `baota-backend/`。

---

## 前端部署

### 方式一：宝塔服务器一键部署（推荐）

`npm run deploy:bt` = 构建 + 打包 `dist` → `scp` 上传 → 服务器端解压到 `web/` 目录（旧目录自动保留为 `web.bak-prev` 用于回滚）。

在项目根目录用 PowerShell 设置环境变量后执行：

```powershell
$env:DEPLOY_SSH_HOST    = 'root@your-server-ip'        # 必填
$env:DEPLOY_REMOTE_ROOT = '/www/wwwroot/your-site'     # 必填，站点根目录
$env:DEPLOY_SSH_KEY     = 'C:\path\to\deploy_key'      # 可选，默认 ssh-keys\deploy_key，
                                                       # 不存在时回退 ~/.ssh/deploy_key
npm run deploy:bt
```

Nginx 站点根目录指向 `$DEPLOY_REMOTE_ROOT/web`。

脚本注意事项（实测经验）：
- `scp` 已内置 `ConnectTimeout` / `ServerAlive*` 超时参数，避免数据通道卡死时部署永久挂起。
- `deploy-bt.ps1` 保持 ASCII-only：PowerShell 5.1 在无 BOM 时按 ANSI 解析 `.ps1`，非 ASCII 字符会导致解析错误。

### 方式二：Cloudflare Pages（Wrangler CLI）

1. **设置 API Token / Key**（切勿把真实凭据提交进仓库）：
   ```powershell
   # 方案 A: 使用 Scoped API Token（推荐）
   $env:CLOUDFLARE_API_TOKEN="你的_TOKEN"

   # 方案 B: 使用 Global API Key
   $env:CLOUDFLARE_API_KEY="你的_GLOBAL_KEY"
   $env:CLOUDFLARE_EMAIL="you@example.com"
   $env:CLOUDFLARE_ACCOUNT_ID="你的_ACCOUNT_ID"
   ```
2. **构建并部署**：
   ```bash
   npm run deploy   # = npm run build + wrangler pages deploy dist
   ```

### 方式三：Cloudflare Pages Git 关联

1. 在 Cloudflare Pages 控制台选择 "Connect to Git"。
2. 配置构建命令为 `npm run build`，输出目录为 `dist`。
3. **环境变量配置**：必须在 Pages 控制台的 Settings 中手动添加：
   - `GEMINI_API_KEY`: 您的 AI 密钥。
   - `STORAGE_SERVER_URL`: 指向云端后端 API 地址。

### 旧方案：Cloudflare D1 后端（可选，非当前生产架构）

当前生产后端为宝塔服务器上的 `baota-backend`（MySQL）。如需完全 Serverless 的替代部署，可使用 Cloudflare D1 方案（`functions/` 目录，路由覆盖较 `baota-backend` 少）：

#### **第一步：创建 D1 数据库**
```bash
npx wrangler d1 create omnifingerprint-db
```
执行后，你会获得一个 `database_id`。

#### **第二步：更新配置**
1. 打开根目录下的 `wrangler.toml`。
2. 将 `database_id` 替换为你刚才获得的 ID。
3. 如有 DeepSeek API Key，在 `[vars]` 中配置。

#### **第三步：初始化数据库架构**
```bash
npx wrangler d1 execute omnifingerprint-db --file=./server/schema.sql
```

#### **第四步：部署到 Cloudflare Pages**
```bash
npm run deploy
```

---

## 云端后端部署（baota-backend）

### 依赖条件

目标服务器必须已安装：
- **Node.js**: v18+（需内置 fetch API）
- **MySQL / MariaDB**
- **PM2**: `npm install -g pm2`
- **Nginx**: 反向代理 443 → `127.0.0.1:7700`

### 1. 初始化数据库

将表结构导入 MySQL：

```bash
mysql -u root -p your_db_name < baota-backend/sql/schema-mysql.sql
```

### 2. 配置环境变量

```bash
cd baota-backend
cp .env.example .env
```

编辑 `.env` 填入：数据库连接（`DB_*`）、监听端口（`PORT`，默认 7700）、API 鉴权密钥（`PUPPETEER_API_SECRET`，需与本地 PUP Server / Email Worker 保持一致）等。

### 3. 上传代码并安装依赖

上传 `baota-backend/` 内容（`api/ src/ sql/ package.json` 等）到服务器站点目录：

```bash
scp -r baota-backend/* root@your-server-ip:/www/wwwroot/your-site/
ssh root@your-server-ip "cd /www/wwwroot/your-site && npm ci --omit=dev"
```

### 4. PM2 启动 / 重启

```bash
# 首次启动
pm2 start src/index.js --name abcdeabc-api

# 后续重启
pm2 restart abcdeabc-api

# 若 pm2 不在非登录 shell 的 PATH 中，使用全路径，例如：
/www/server/nodejs/v14.17.6/bin/pm2 restart abcdeabc-api
```

### 部署验证

- `pm2 list` 中进程状态为 online；
- 服务监听 `127.0.0.1:7700` 且接口响应正常 JSON；
- 通过 Nginx 反代的 `https://your-domain/api/...` 访问正常。

### 运维注意事项（实测经验）

- **覆盖远端路由文件前必须先 diff**：先 `scp` 下载线上 `api/routes/*.js` 与本地对比，确认无线上独有改动后再上传；合并云端独有逻辑时把线上版本备份为 `*.bak-<feature>`，避免覆盖丢失（如级联删除等线上独有逻辑）。
- **文件传输**：新版 OpenSSH `scp` 走 SFTP 协议、不经过远端 shell，直接传路径即可（无需加引号）；PowerShell 传含特殊字符的路径（如 `[[path]].js`）须用 `-LiteralPath`；远端脚本经 stdin 执行前先去除 CRLF（`-replace "`r`n","`n"`）。

---

## 服务管理 (线上)

登录线上服务器，使用 PM2 管理后端进程：

```bash
# 查看服务状态
pm2 list

# 查看所有日志
pm2 logs abcdeabc-api

# 重启服务
pm2 restart abcdeabc-api

# 停止服务
pm2 stop abcdeabc-api
```
