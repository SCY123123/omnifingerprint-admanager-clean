# OmniFingerprint AdManager

A self-hosted fingerprint-browser profile manager and multi-platform ad automation workbench.
Frontend runs on React + Vite; a local PUP Server (Node.js + Puppeteer/Playwright) drives real Chrome instances on your own machine; a lightweight cloud backend (MySQL) stores profiles and business data.

自托管的指纹浏览器配置管理与多平台广告自动化工作台。前端为 React + Vite；本地 PUP Server（Node.js + Puppeteer/Playwright）在本机驱动真实 Chrome 实例；轻量云端后端（MySQL）负责存储配置与业务数据。

> ⚠️ **Legal / 合规提示**: This project is for managing your own advertising accounts and automating your own workflows. You are responsible for complying with the terms of service of any platform you use it with, as well as applicable laws in your jurisdiction.
>
> 本项目仅用于管理自己的广告账号与自动化自己的工作流程。使用本项目时请自行遵守所操作平台的服务条款及所在地法律法规。
>
> **Trademarks / 商标声明**: Facebook, Meta, Instagram, TikTok, Google, Cloudflare, Mail.tm and other names mentioned in this project are trademarks of their respective owners. They are used here for identification and compatibility description only, and do not imply any affiliation, sponsorship, or endorsement.
>
> 本项目文档与代码中出现的 Facebook、Meta、Instagram、TikTok、Google、Cloudflare、Mail.tm 等名称，均为其各自所有者的商标，此处仅用于标识与兼容性说明，不代表任何关联、赞助或背书。

---

## English

### Architecture

```
┌─────────────────────────────┐      ┌──────────────────────────────┐
│  Frontend (React + Vite)    │ HTTP │  Local PUP Server (port 9999)│
│  - Profile management       │─────▶│  - Puppeteer / Playwright    │
│  - Ad automation UI         │      │  - Real Chrome instances     │
│  Cloudflare Pages / Nginx   │      │  - Cookie & fingerprint mgmt │
└─────────────┬───────────────┘      └──────────────┬───────────────┘
              │ /api/* (proxied)                    │ sync
              ▼                                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  Cloud backend (baota-backend/, Node + MySQL)                    │
│  - Profiles / BM / ad accounts / billing / shop data             │
└──────────────────────────────────────────────────────────────────┘
```

- `server/` — **Local PUP Server** (runs on your PC). Launches and controls real Chrome/Edge instances via CDP, injects cookies, manages fingerprints/proxies, executes automation jobs (account info fetching, BM creation, ad publishing, ...). **Never deploy this to a cloud server.**
- `baota-backend/` — **Cloud storage backend** (Node + MySQL). Stores profiles, business data, and shop/recharge features. Designed for a BT-panel / any Linux box behind Nginx.
- Root React app — **Frontend**. Talks to the local PUP Server directly (ports/secret) and to the cloud backend via `/api/*`.
- `functions/` — Cloudflare Pages Functions that proxy `/api/*` to your backend.
- `email-worker/` — Cloudflare Email Worker for the private temp-mail system (forwards inbound mail to the backend).

### Quick Start

```bash
# 1. Frontend
npm install
cp .env.example .env.local        # fill in VITE_LOCAL_SERVER_SECRET etc.
npm run dev

# 2. Local PUP Server (separate terminal)
set PUPPETEER_API_SECRET=<same as VITE_LOCAL_SERVER_SECRET>
set STORAGE_SERVER_URL=https://your-backend.example.com
node server/puppeteer-api-server.js        # listens on http://localhost:9999

# 3. Cloud backend (see baota-backend/)
cd baota-backend
cp .env.example .env               # fill in DB_* and PUPPETEER_API_SECRET
npm install && node src/index.js
```

Production build: `npm run build` (output in `dist/`). Deployment options (BT panel or Cloudflare Pages) are described in [DEPLOY.md](DEPLOY.md).

### Key Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_LOCAL_SERVER_SECRET` | frontend build | Secret sent as `X-Api-Secret` to the local PUP Server |
| `VITE_MAIL_DOMAIN` | frontend build | Private mail domain for the temp-mail UI |
| `PUPPETEER_API_SECRET` | local server / cloud backend | Shared secret between frontend, local server and cloud backend |
| `STORAGE_SERVER_URL` | local server | Cloud backend base URL for data sync |
| `MAIL_DOMAIN` | local server | Domain used when generating mail addresses |
| `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME` | cloud backend | MySQL connection |
| `DEEPSEEK_API_KEY` / `GEMINI_WEB_KEY` | cloud backend | Optional AI copywriting features |

See [.env.example](.env.example) and [baota-backend/.env.example](baota-backend/.env.example) for the full list.

### Security Notes

- All secrets are injected via environment variables — **never commit real keys, domains, or server IPs**. The repo only contains placeholders.
- The local PUP Server should only listen on your own machine; keep `PUPPETEER_API_SECRET` strong and private.
- Cookie data is sensitive: it stays in your local SQLite/Chrome profile and your own database.

---

## 中文

### 架构

- `server/` — **本地 PUP Server**（运行在你自己的电脑上）。通过 CDP 启动并控制真实 Chrome/Edge 实例，注入 Cookie、管理指纹与代理，执行自动化任务（获取账号信息、创建 BM、发布广告等）。**切勿部署到云端服务器。**
- `baota-backend/` — **云端存储后端**（Node + MySQL）。存储配置、业务数据以及商城/充值功能，适合宝塔面板或任意 Linux + Nginx 环境。
- 根目录 React 应用 — **前端**。直接调用本地 PUP Server，通过 `/api/*` 调用云端后端。
- `functions/` — Cloudflare Pages Functions，把 `/api/*` 转发到你的后端。
- `email-worker/` — Cloudflare Email Worker，私有临时邮箱系统的收信入口（把入站邮件转发给后端落库）。

### 快速开始

```bash
# 1. 前端
npm install
cp .env.example .env.local        # 填入 VITE_LOCAL_SERVER_SECRET 等
npm run dev

# 2. 本地 PUP Server（另开终端）
set PUPPETEER_API_SECRET=<与 VITE_LOCAL_SERVER_SECRET 相同>
set STORAGE_SERVER_URL=https://你的后端域名
node server/puppeteer-api-server.js        # 监听 http://localhost:9999

# 3. 云端后端（见 baota-backend/）
cd baota-backend
cp .env.example .env               # 填入 DB_* 与 PUPPETEER_API_SECRET
npm install && node src/index.js
```

生产构建：`npm run build`（产物在 `dist/`）。部署方式（宝塔面板或 Cloudflare Pages）见 [DEPLOY.md](DEPLOY.md)。

### 关键环境变量

| 变量 | 位置 | 用途 |
|---|---|---|
| `VITE_LOCAL_SERVER_SECRET` | 前端构建 | 前端请求本地 PUP Server 时携带的 `X-Api-Secret` |
| `VITE_MAIL_DOMAIN` | 前端构建 | 临时邮箱界面使用的私有收信域名 |
| `PUPPETEER_API_SECRET` | 本地服务 / 云端后端 | 前端、本地服务、云端后端之间共享的鉴权密钥 |
| `STORAGE_SERVER_URL` | 本地服务 | 云端后端地址，用于数据同步 |
| `MAIL_DOMAIN` | 本地服务 | 生成邮箱地址时使用的域名 |
| `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME` | 云端后端 | MySQL 连接 |
| `DEEPSEEK_API_KEY` / `GEMINI_WEB_KEY` | 云端后端 | 可选的 AI 文案功能 |

完整列表见 [.env.example](.env.example) 与 [baota-backend/.env.example](baota-backend/.env.example)。

### 安全提示

- 所有密钥通过环境变量注入——**切勿向仓库提交真实密钥、域名或服务器 IP**，仓库中只保留占位符。
- 本地 PUP Server 只应监听本机；`PUPPETEER_API_SECRET` 请设置足够强度并妥善保管。
- Cookie 数据属于敏感信息：仅存于本地 SQLite/Chrome 配置与你自己的数据库中。

---

## License

Copyright (C) 2026 omnifingerprint-admanager

This project is licensed under **GNU GPL v3.0 or later** — see [LICENSE](LICENSE).
本项目基于 **GPL-3.0-or-later** 协议开源，完整协议文本见 [LICENSE](LICENSE)。你可以自由使用、修改、分发（含商业用途），但衍生作品必须以相同协议开源。
