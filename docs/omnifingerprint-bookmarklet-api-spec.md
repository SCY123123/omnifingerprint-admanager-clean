# AdSpy Bookmarklet API 功能技术文档

> 来源：`限额查看代码.txt` 解压后的书签代码（`限额解压.js`，188KB）
> 功能：Facebook 广告账户管理一站式工具，通过浏览器上下文直接调用 Facebook 内部 API

---

## 架构说明

所有功能均需在 **浏览器上下文** 内执行，依赖以下核心 Session 变量：

| 变量 | 来源 | 用途 |
|------|------|------|
| `window.privateToken` | 用户 Token | 所有 Graph API 调用鉴权 |
| `window.socid` | Facebook 用户 ID | GraphQL 请求的 `actor_id`/`__user` |
| `window.dtsg` | 页面 HTML | CSRF Token，用于所有内部 GraphQL 请求 |
| `window.spinR / spinB / spinT / hsi` | 页面 HTML | GraphQL 请求的版本/旋转参数 |

---

## 一、广告账户操作

### 1.1 查看账户状态/限额 (showaccstatus)

**API**: `POST https://graph.facebook.com/v19.0/act_{accountId}`  
**参数**: `fields=id,name,account_status,balance,currency,amount_spent,daily_spend_limit,spend_cap,...`  
**功能**: 获取账户余额、花费、限额、币种、状态等全字段  

### 1.2 修改货币 (ProcessEditcurr)

**API**: `POST https://graph.facebook.com/v19.0/act_{accountId}?fields=id,name,timezone_id`  
**Body**: `currency={新币种}&access_token={token}`  
**功能**: 修改广告账户货币（Graph API 原生支持，需广告账户处于特定状态）

### 1.3 修改时区 (ProcessEdittzone)

**API**: `POST https://graph.facebook.com/v19.0/act_{accountId}?fields=id,name,timezone_id`  
**Body**: `timezone_id={新时区ID}&access_token={token}`  
**功能**: 修改广告账户时区

### 1.4 修改账户名称 (showaccstatusupdatename)

**API**: `POST https://graph.facebook.com/v19.0/{accountId}`  
**Body**: `name={新名称}&access_token={token}`  
**功能**: 修改广告账户显示名称

### 1.5 关闭广告账户 (deladacc)

**API**: `POST https://{host}/ads/ajax/account_close/`  
**Body**: `account_id={adaccid}&fb_dtsg={dtsg}&__user={socid}`  
**功能**: 关闭/删除广告账户（需通过 Facebook 内部 GraphQL 端点，不依赖 Token）

### 1.6 移除广告账户用户 (remadacc)

**API**: `DEL https://graph.facebook.com/v19.0/act_{adaccid}/users/{rmid}?access_token={token}`  
**功能**: 从广告账户中移除指定用户

---

## 二、绑卡操作

### 2.1 绑卡到广告账户 (addCCtoadAccReq2)

**端点**: `POST https://business.secure.facebook.com/ajax/payment/token_proxy.php?tpe=%2Fapi%2Fgraphql%2F`  
**Content-Type**: `application/x-www-form-urlencoded`  
**doc_id**: `4126726757375265`  
**核心变量 (JSON 序列化到 variables 字段)**:

```json
{
  "input": {
    "billing_address": { "country_code": "{ccIso}" },
    "billing_logging_data": {},
    "cardholder_name": "",
    "credit_card_first_6": { "sensitive_string_value": "{first6}" },
    "credit_card_last_4": { "sensitive_string_value": "{last4}" },
    "credit_card_number": { "sensitive_string_value": "{ccNumber}" },
    "csc": { "sensitive_string_value": "{ccCVC}" },
    "expiry_month": "{ccMonth}",
    "expiry_year": "{ccYear}",
    "payment_account_id": "{adAccountId}",
    "payment_type": "MOR_ADS_INVOICE",
    "unified_payments_api": true,
    "actor_id": "{fbSocId}",
    "client_mutation_id": "1"
  }
}
```

**关键参数**:
- `fb_dtsg`: 页面 CSRF Token（必须）
- `__user` / `av`: Facebook 用户 ID
- `__rev` / `__spin_r`: 页面版本号

**响应判断**: `result.add_credit_card !== null` 表示成功

---

## 三、申诉操作

### 3.1 广告违规申诉 (appealadcreo)

**端点**: `POST https://business.facebook.com/ads/integrity/appeals/creation/ajax/`  
**Body**: `adgroup_id={id}&callsite=ADS_MANAGER&fb_dtsg={dtsg}&__user={socid}&access_token={token}`  
**功能**: 对广告组违规提起申诉

### 3.2 广告账户申诉 (appealadsacc)

**端点**: `POST https://www.facebook.com/api/graphql/`  
**doc_id**: (通过 fb_api_req_friendly_name: `useAdAccountALRAppealMutation` 识别)  
**功能**: 对广告账户限制提起申诉

### 3.3 个人主页申诉 (appealfp)

**端点**: `POST https://www.facebook.com/api/graphql/`  
**doc_id**: 同上，`useAdAccountALRAppealMutation`  
**功能**: 对个人主页（Profile）限制提起申诉

---

## 四、BM (Business Manager) 操作

### 4.1 查看 BM 详情 (PzrdBmList)

**端点**: `POST https://www.facebook.com/api/graphql`  
**friendly_name**: `AccountQualityHubAssetOwnerViewV2Query`  
**功能**: 查询 BM 的质量状态、违规记录

### 4.2 查看 BM 状态 (showbmstatus)

**端点**: `POST https://graph.facebook.com/v19.0/{bmid}?fields=...&access_token={token}`  
**功能**: 获取 BM 的 verification_status、payment_status 等

### 4.3 创建 BM (AddBMProcessForm - 旧方案)

**端点**: `POST https://www.facebook.com/api/graphql/`  
**friendly_name**: `useBusinessCreateFlowMutation`  
**注意**: 当前系统已改用 `POST /me/businesses` Graph API 创建

### 4.4 添加广告账户到 BM (showMorePopupBMAccsAddProcessForm)

**端点**: `POST https://graph.facebook.com/v19.0/{bmid}/adaccounts`  
**Body**: `adaccount_id={accid}&access_token={token}`  
**功能**: 将已存在的广告账户添加到 BM 管理

### 4.5 请求广告账户访问 (showMorePopupBMAccsReqProcessForm)

**端点**: `POST https://graph.facebook.com/v19.0/{bmid}/adaccountrequests`  
**Body**: `adaccount_id={accid}&access_token={token}`  
**功能**: 向广告账户所有者发送访问请求

### 4.6 从 BM 移除广告账户 (showMorePopupBMAccsRm)

**端点**: `DEL https://graph.facebook.com/v19.0/{bmid}/adaccounts/{accid}?access_token={token}`  
**功能**: 将广告账户从 BM 移除

### 4.7 BM 用户管理

| 操作 | 端点 | 说明 |
|------|------|------|
| 查看用户 | `POST {bmid}/business_users` | 列出 BM 用户 |
| 编辑角色 | `POST {bmid}/business_users/{userid}` | 修改用户权限 |
| 移除用户 | `DEL {bmid}/business_users/{userid}` | 删除 BM 用户 |
| 添加用户 | `POST {bmid}/business_users` | 邀请新用户 |

---

## 五、主页(Page)操作

### 5.1 创建主页 (AddFPProcessForm)

**端点**: `POST https://graph.facebook.com/v19.0/me/accounts`  
**注意**: 当前系统已实现更完善的创建逻辑（支持随机名称、代理选择、类别映射）

### 5.2 删除主页 (delfp)

**端点**: `DEL https://graph.facebook.com/v19.0/{fpid}?access_token={token}`  
**功能**: 删除公共主页

### 5.3 恢复隐藏主页 (unhidefp)

**端点**: `POST https://graph.facebook.com/v19.0/{fpid}`  
**Body**: `is_published=false&access_token={token}`  
**功能**: 取消主页发布（隐藏）

### 5.4 获取主页 Token (getPageToken)

**端点**: `GET https://graph.facebook.com/v19.0/{page_id}?fields=access_token&access_token={token}`  
**功能**: 获取指定主页的长期访问令牌

---

## 六、其他功能

### 6.1 Token/会话管理

- **checkauth**: 验证当前登录状态
- **getAccessTokenFunc**: 从 `__accessToken` 或 localStorage 提取 Token
- **checkIpFunc / checkVerFunc**: 检查 IP 和版本

### 6.2 检查 BM 有效性 (checkBmFunc)  

**端点**: `GET https://graph.facebook.com/v19.0/{bmid}?fields=verification_status&access_token={token}`  
**功能**: 验证 BM 是否可用

---

## 七、关键发现

### 7.1 绑卡 API (最重要)

Facebook 没有公开的绑卡 REST API，通过 `business.secure.facebook.com` 的 GraphQL 端点实现，需要：
1. `fb_dtsg`（页面 CSRF Token）
2. `__user`（用户 ID）
3. 固定的 `doc_id: 4126726757375265`
4. `credentials: 'include'`（携带 Cookie）

### 7.2 货币/时区修改

通过 `POST /act_{id}` 官方 Graph API 即可修改，**无需 fb_dtsg**，只需要 `access_token`
- `currency` 字段修改币种
- `timezone_id` 字段修改时区

### 7.3 申诉功能

依赖 Facebook 内部 GraphQL 端点，需要 `fb_dtsg` 和 `doc_id`，这些 doc_id 可能随页面版本变化。

### 7.4 集成方式建议

| 功能 | 集成方式 |
|------|----------|
| 绑卡 | **浏览器上下文**：启动浏览器 → 提取 dtsg/socid → page.evaluate 内调用 API |
| 货币/时区修改 | **纯 API**：直接 `POST /act_{id}` 带上 Token 即可，浏览器仅做保底 |
| 申诉 | **浏览器上下文**：需要 dtsg，需启动浏览器 |
| 删除/移除账户 | **纯 API** 或浏览器上下文皆可 |
| BM 用户管理 | **纯 API**：Graph API 原生支持 |
