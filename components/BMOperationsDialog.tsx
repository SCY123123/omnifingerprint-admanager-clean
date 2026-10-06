import React, { useState, useEffect } from 'react';
import { X, UserPlus, CreditCard, Users, Globe, Mail, Shield, Briefcase, Loader2, CheckCircle, AlertTriangle, UserCog, Share2, Server, Building2, UserCheck, Search, ShieldCheck, Upload, FileText, RefreshCw, Target, Trash2 } from 'lucide-react';
import { SearchSelect, useBusinessOptions } from './SearchSelect';
import { submitJob, waitForJob, type SlowOpType } from './jobQueue';
import { AdAccountFields, defaultAdAccountForm, adNamePayload, adBillingPayload, type AdAccountForm } from './AdAccountFields';

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

// 🚀 随机 BM 名称词库（与 AssetViewer 保持一致）
const RANDOM_BM_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Future Vision', 'Ocean Breeze', 'Mountain Peak', 'Urban Style', 'Zen Master',
  'Bright Studio', 'Prime Media', 'Elite Commerce', 'Global Trade', 'Apex Digital',
  'Nova Solutions', 'Vertex Labs', 'Quantum Edge', 'Stellar Works', 'Crystal Bloom'
];

const genRandomBMName = () => {
  const rn = RANDOM_BM_NAMES[Math.floor(Math.random() * RANDOM_BM_NAMES.length)];
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${rn} ${suffix}`;
};

interface BMItem {
  profileId: string;
  bmId: string;
  name?: string;
}

interface BMOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  items: BMItem[];
  /** 🔓「仅配置」模式：打开时定位到该 tab，并且只显示这一个 tab（被别的流程借去填参数时用） */
  initialTab?: TabType;
  /** 🔓「仅配置」模式：点提交时不真的提交队列任务，而是把构造好的任务交回调用方（onSaveConfig） */
  configureOnly?: boolean;
  /** 仅配置模式下点「保存配置」时回调，收到的就是原本要交给 submitJob 的那份任务 */
  onSaveConfig?: (cfg: { type: string; title: string; items: Array<{ key: string; label: string; payload: any }> }) => void;
  /**
   * 🔗 创建BM（勾了「建完自动获取信息」）任务跑完后回调，参数是涉及的配置 ID。
   *    服务端队列已经抓完并同步云端，但 localStorage 缓存只有前端能写 ——
   *    由调用方（AssetViewer）负责把这批结果落位到本地缓存 + 刷新界面。
   */
  onFetchedAssets?: (pids: string[]) => void;
}

type TabType = 'invite' | 'createAccount' | 'createBM' | 'createPixel' | 'pixelGrant' | 'grantPage' | 'users' | 'bindCard' | 'sharePartner' | 'assignPersonalAd' | 'grantPersonalPage' | 'verifyBM' | 'refreshInfo' | 'syncPermissions';

export const BMOperationsDialog: React.FC<BMOperationsDialogProps> = ({ isOpen, onClose, items, initialTab, configureOnly = false, onSaveConfig, onFetchedAssets }) => {
  // 系统 BM 列表（分享合作伙伴 / 以后其它需要选 BM 的地方共用），支持按名称或 ID 搜索
  const { options: bmOptions } = useBusinessOptions(null);
  const [activeTab, setActiveTab] = useState<TabType>('invite');
  // 🚀 打开时默认显示"创建广告号"tab；仅配置模式下改成停在调用方指定的 tab（例如智能发布的「创建BM」）
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(configureOnly && initialTab ? initialTab : 'createAccount');
  }, [isOpen, configureOnly, initialTab]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'EMPLOYEE'>('EMPLOYEE');
  // 📧 邀请用户：自动模式（生成临时邮箱 → 邀请 → 收信提取链接），每个 BM 生成 N 个
  const [inviteAuto, setInviteAuto] = useState(false);
  const [inviteAutoCount, setInviteAutoCount] = useState(1);
  // 🏬 商城目录 + 写入目标（自动模式可选：把分组文本写进某个商品）
  //    inviteProductPick: '__none__' 不写商品 / '__new__' 新建 / 其它 = 已有商品 id
  const [shopBlocks, setShopBlocks] = useState<any[]>([]);
  const [shopProducts, setShopProducts] = useState<any[]>([]);
  const [inviteBlockId, setInviteBlockId] = useState('');
  const [inviteProductPick, setInviteProductPick] = useState('__none__');
  const [inviteNewTitle, setInviteNewTitle] = useState('');
  // 📧 创建BM：建完自动生成邀请链接（每个 BM N 个）
  const [bmInviteEnabled, setBmInviteEnabled] = useState(false);
  // 🔗 创建BM联动：建完后自动对涉及配置跑一次「获取信息」（广告号数/BM状态等立即填充）
  const [bmAutoFetchInfo, setBmAutoFetchInfo] = useState(true);
  // 🛒 创建BM联动：邀请链接生成后自动上架商城（价格 USDT，默认 0）
  const [bmShopPublish, setBmShopPublish] = useState(false);
  const [bmShopPrice, setBmShopPrice] = useState(0);
  const [bmInviteCount, setBmInviteCount] = useState(1);
  // 🆕 广告号字段组（命名方式 + 时区/货币 + 账单信息）—— 与「配置管理页的批量创建BM」共用同一份组件，
  //    避免两个入口字段不同步（之前批量那边漏了时区，建出来的广告号时区是默认值）。
  const [adForm, setAdForm] = useState<AdAccountForm>(defaultAdAccountForm);
  const patchAd = (p: Partial<AdAccountForm>) => setAdForm(v => ({ ...v, ...p }));
  const [accountCount, setAccountCount] = useState(1);
  const [createPixel, setCreatePixel] = useState(false);
  const [assignAdmin, setAssignAdmin] = useState(false);
  const [pageId, setPageId] = useState('');
  const [ccNumber, setCcNumber] = useState('');
  const [ccYear, setCcYear] = useState('');
  const [ccMonth, setCcMonth] = useState('');
  const [ccCVC, setCcCVC] = useState('');
  const [ccIso, setCcIso] = useState('US');
  const [bindCurrency, setBindCurrency] = useState('USD');
  const [bindTimezone, setBindTimezone] = useState('');
  const [adAccountId, setAdAccountId] = useState('');
  // 🆕 创建像素
  const [pixelName, setPixelName] = useState('');
  // 'bm' = 该 BM 名下全部广告号；'manual' = 手动指定广告号 ID（只跑一次，用第一个选中配置的登录态）
  const [pixelScope, setPixelScope] = useState<'bm' | 'manual'>('bm');
  const [pixelAdAccountIds, setPixelAdAccountIds] = useState('');
  // 🆕 创建后自动认领到 BM（BM 管理员随即可完全控制该像素）
  const [autoClaimPixel, setAutoClaimPixel] = useState(true);
  // 🆕 像素授权（分享给合作方 BM / 关联广告号）
  const [pixelGrantMode, setPixelGrantMode] = useState<'partner' | 'adaccount'>('partner');
  const [grantPixelIds, setGrantPixelIds] = useState('');
  const [grantPartnerBmId, setGrantPartnerBmId] = useState('');
  const [grantTasks, setGrantTasks] = useState<string[]>(['ANALYZE', 'UPLOAD', 'ADVERTISE']);
  const [grantAdAccountIds, setGrantAdAccountIds] = useState('');
  const [bmAdAccounts, setBmAdAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingBmAdAccounts, setLoadingBmAdAccounts] = useState(false);
  const [loadingBmPixels, setLoadingBmPixels] = useState(false);
  // 🆕 分享到合作伙伴
  const [partnerBusinessId, setPartnerBusinessId] = useState('');
  const [partnerTasks, setPartnerTasks] = useState<string[]>(['MANAGE', 'ADVERTISE', 'ANALYZE']);
  const [shareAdAccountIds, setShareAdAccountIds] = useState('');
  // 🆕 创建 BM
  const [bmName, setBmName] = useState('');
  const [isRandomBMName, setIsRandomBMName] = useState(false);
  const [useProfileIdFirstName, setUseProfileIdFirstName] = useState(false);   // 🆕 「名字」用浏览器配置 ID 填充
  const [useProfileIdLastName, setUseProfileIdLastName] = useState(false);     // 🆕 「姓氏」用浏览器配置 ID 填充
  const [bmEmail, setBmEmail] = useState('');
  const [isRandomBMEmail, setIsRandomBMEmail] = useState(false);   // 🆕 与「批量操作」创建BM表单保持一致
  const [bmFirstName, setBmFirstName] = useState('');
  const [bmLastName, setBmLastName] = useState('');
  const [bmCountry, setBmCountry] = useState('');
  const [bmCount, setBmCount] = useState(1);
  const [bmAdAccountCount, setBmAdAccountCount] = useState(1);   // 🆕 每个 BM 创建几个广告号
  const [bmCreateAdAccount, setBmCreateAdAccount] = useState(false);
  const [bmCreatePage, setBmCreatePage] = useState(false);
  const [bmDefaultPageName, setBmDefaultPageName] = useState('');
  // 🆕 授权到个人号 (传入 FB 用户 ID,固定全权限)
  const [personalFbUserId, setPersonalFbUserId] = useState('');
  const [personalAdAccountIds, setPersonalAdAccountIds] = useState(''); // 可选,留空则自动拉取 BM 拥有的
  const [personalPageIds, setPersonalPageIds] = useState(''); // 可选,留空则自动拉取 BM 拥有的
  // 🆕 BM 认证
  const [verifyLegalName, setVerifyLegalName] = useState('');
  const [verifyLegalAddress, setVerifyLegalAddress] = useState('');
  const [verifyPhone, setVerifyPhone] = useState('');
  const [verifyWebsite, setVerifyWebsite] = useState('');
  const [verifyBusinessType, setVerifyBusinessType] = useState<'ADVERTISER' | 'ADVERTISING_AGENCY' | 'OTHER'>('ADVERTISER');
  const [verifyDocs, setVerifyDocs] = useState<Array<{ filename: string; mimeType: string; base64: string }>>([]);
  const [verifyBmId, setVerifyBmId] = useState(''); // 指定要认证的 BM ID（可空，空则使用 items[0].bmId）
  const [verifyProfileId, setVerifyProfileId] = useState(''); // 指定 profileId（可空，空则使用 items[0].profileId）
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<Array<{ bmId: string; status: 'success' | 'error'; message: string }>>([]);
  const [usersData, setUsersData] = useState<any>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  // 🆕 BM 成员批量操作：勾选 → 改角色 / 移除
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<'ADMIN' | 'EMPLOYEE'>('ADMIN');
  const [usersBusy, setUsersBusy] = useState(false);
  const [proxyList, setProxyList] = useState<Array<any>>([]);
  const [selectedProxyId, setSelectedProxyId] = useState('');
  const [proxyManualInput, setProxyManualInput] = useState('');
  const [proxyType, setProxyType] = useState('http');

  // 🚀 加载代理列表：弹窗打开时从缓存读取，缓存为空则从 API 拉取
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const raw = localStorage.getItem('proxy-list');
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length > 0) {
            setProxyList(arr);
            return;
          }
        }
      } catch {}
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        if (!authToken) return;
        const r = await fetch(`${base}/api/proxies`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!r.ok) return;
        const j = await r.json();
        const list = Array.isArray(j?.data) ? j.data : [];
        setProxyList(list);
        try { localStorage.setItem('proxy-list', JSON.stringify(list)); } catch {}
      } catch {}
    })();
  }, [isOpen]);

  // 🚀 随机邮箱生成：使用常见邮箱域名 + 随机用户名
  const generateRandomEmail = () => {
    const domains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const firstNameLen = 4 + Math.floor(Math.random() * 4); // 4-7
    const lastNameLen = 3 + Math.floor(Math.random() * 3);  // 3-5
    let user = '';
    for (let i = 0; i < firstNameLen; i++) user += chars[Math.floor(Math.random() * chars.length)];
    user += '.';
    for (let i = 0; i < lastNameLen; i++) user += chars[Math.floor(Math.random() * chars.length)];
    // 末尾加 2-4 位数字，避免重复
    const numLen = 2 + Math.floor(Math.random() * 3);
    let num = '';
    for (let i = 0; i < numLen; i++) num += Math.floor(Math.random() * 10);
    const domain = domains[Math.floor(Math.random() * domains.length)];
    return `${user}${num}@${domain}`;
  };

  /** 广告号「命名方式 + 时区/货币 + 账单信息」字段组 —— 与配置管理页的批量创建BM 共用同一份实现 */
  const adAccountFields = (manualPlaceholder?: string) => (
    <AdAccountFields value={adForm} onChange={patchAd} manualPlaceholder={manualPlaceholder} />
  );

  // 🚀 切换到 createBM tab 时自动填充随机邮箱和随机 BM 名称
  useEffect(() => {
    if (activeTab === 'createBM') {
      if (!bmEmail && !isRandomBMEmail) setBmEmail(generateRandomEmail());
      if (isRandomBMName) setBmName(genRandomBMName());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // 🏬 切到「邀请用户」tab 时拉一次商城目录（板块 + 商品），供「写入商品」下拉用。
  //    ⚠️ 这里不能引用 lbase：它在下面 `if (!isOpen) return null` 之后声明，
  //       而 hook 区（依赖数组求值）在这之前执行，会撞 TDZ。
  useEffect(() => {
    if (!isOpen || activeTab !== 'invite') return;
    let cancelled = false;
    (async () => {
      try {
        const base = ((import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999').replace(/\/$/, '');
        const r = await fetch(`${base}/api/shop/catalog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: '{}',
        });
        const j = await r.json().catch(() => null);
        if (!cancelled && j && j.success) {
          setShopBlocks(j.blocks || []);
          setShopProducts(j.products || []);
        }
      } catch { /* 拉不到就退化成「不写商品」，不阻塞邀请流程 */ }
    })();
    return () => { cancelled = true; };
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const lbase = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL || 'http://localhost:9999';

  // 🧵 统一提交助手：把一批 BM 操作丢进服务端队列。
  //    执行/并发/进度/取消全在后端，刷新或关弹窗都不会中断，也不会在前端开并发窗口抢浏览器。
  const submitBmQueueJob = async (
    type: SlowOpType,
    title: string,
    jobItems: Array<{ key: string; label: string; payload: any }>,
  ) => {
    if (jobItems.length === 0) { alert('没有可用的目标'); return; }
    setProcessing(true);
    setResults([]);
    try {
      const job = await submitJob({ type, title, items: jobItems });
      setResults([{
        bmId: '-', status: 'success',
        message: `已提交 ${jobItems.length} 项到执行队列（${job.id}）：${title}。进度/取消见左侧「执行队列」，可放心刷新或切页。`,
      }]);
    } catch (e: any) {
      setResults([{ bmId: '-', status: 'error', message: `提交失败: ${e?.message || e}` }]);
    } finally {
      setProcessing(false);
    }
  };

  // 🧵 已统一走队列（原来是前端直连循环）
  const handleInvite = () => {
    // 🆕 支持一次填多个邮箱：换行 / 逗号 / 分号 / 空格分隔都行
    const emailList = [...new Set(email.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
    if (emailList.length === 0) { alert('请输入至少一个邮箱'); return; }
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: { profileId: item.profileId, businessId: item.bmId, emails: emailList, role },
    }));
    void submitBmQueueJob('invite_users', `邀请用户（${jobItems.length} 个 BM）`, jobItems);
  };

  // 📧 自动模式：每个选中的 BM 生成 N 个邀请链接（后端生成临时邮箱→邀请→收信提取→写回 BM）
  //    ⚠️ 每个链接要轮询收信最长 45s，属慢操作 → 走队列，避免前端卡死
  const handleInviteLinks = async () => {
    const usable = items.filter(it => it.profileId && it.bmId);
    if (usable.length === 0) { alert('请先选择至少一个 BM'); return; }
    const roleVal = role === 'ADMIN' ? 'admin' : 'employee';
    const targets = usable.map((it) => ({ profileId: it.profileId, businessId: it.bmId }));

    // 🏬 指定了写入商品 → **整批聚合成一个队列项**：
    //    多个 BM 若各开一项并发写同一个商品，会互相覆盖 invite_link，所以必须在一项里串完再写。
    if (inviteProductPick !== '__none__') {
      const picked = inviteProductPick === '__new__' ? null : shopProducts.find(p => String(p.id) === String(inviteProductPick));
      const newTitle = inviteNewTitle.trim();
      if (inviteProductPick === '__new__' && !newTitle) { alert('请填写新商品标题'); return; }
      if (inviteProductPick !== '__new__' && !picked) { alert('选中的商品已不存在，请重新选择'); return; }
      const title = picked ? String(picked.title || '') : newTitle;
      setProcessing(true);
      setResults([]);
      try {
        const job = await submitJob({
          type: 'generate_invite_links_to_product',
          title: `生成邀请链接并写入商品「${title}」（${targets.length} 个 BM × ${inviteAutoCount}）`,
          items: [{
            key: 'batch',
            label: title,
            payload: {
              targets,
              count: inviteAutoCount,
              role: roleVal,
              // 已有商品：带上完整原字段（云端 save 是整行 UPDATE，缺字段会被重置为空）
              productId: picked ? picked.id : undefined,
              product: picked || undefined,
              productTitle: title,
              // 板块：显式选了用选的；选了已有商品则沿用其原板块；新建且未选=未分组
              blockId: inviteBlockId !== '' ? Number(inviteBlockId) : (picked ? picked.block_id : null),
            },
          }],
        });
        setResults([{
          bmId: '-', status: 'success',
          message: `已提交到执行队列（${job.id}）：整批 ${targets.length} 个 BM 的邀请链接会按「BMID + 临时邮箱 + 邀请链接」分组写进商品「${title}」，商品数量 = 实际生成成功的 BM 组数。进度/取消见左侧「执行队列」。`,
        }]);
      } catch (e: any) {
        setResults([{ bmId: '-', status: 'error', message: `提交失败: ${e?.message || e}` }]);
      } finally {
        setProcessing(false);
      }
      return;
    }

    // 未指定商品：保持原样，每个 BM 一个队列项（只生成链接，不写商品）
    setProcessing(true);
    setResults([]);
    const jobItems = usable.map((it) => ({
      key: `${it.profileId}::${it.bmId}`,
      label: `${it.profileId} / ${it.bmId}`,
      payload: {
        profileId: it.profileId,
        businessId: it.bmId,
        count: inviteAutoCount,
        role: roleVal,
      },
    }));
    try {
      const job = await submitJob({
        type: 'generate_invite_links',
        title: `生成邀请链接（${jobItems.length} 个 BM × ${inviteAutoCount}）`,
        items: jobItems,
      });
      setResults([{
        bmId: '-', status: 'success',
        message: `已提交 ${jobItems.length} 个 BM 的邀请链接生成任务（${job.id}），每个 BM ${inviteAutoCount} 个。执行/进度见左侧「执行队列」，可放心刷新或切页。`,
      }]);
    } catch (err: any) {
      setResults([{ bmId: '-', status: 'error', message: `提交失败: ${err?.message || err}` }]);
    }
    setProcessing(false);
  };

  const handleCreateAccount = async () => {
    if (adForm.nameMode === 'manual' && !adForm.manualName.trim()) { alert('请输入广告号名称'); return; }
    const usable = items.filter(it => it.profileId && it.bmId);
    if (usable.length === 0) { alert('请先选择至少一个 BM'); return; }
    // 🧵 走服务端队列（每个选中的 BM 一个队列项）：执行/并发/进度/取消都在后端，
    //    刷新或切页都不会中断。名称与账单参数交给后端在「真正执行创建」那一刻生成。
    setProcessing(true);
    setResults([]);
    const jobItems = usable.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: {
        profileId: item.profileId,
        businessId: item.bmId,
        name: adForm.manualName.trim(),
        ...adNamePayload(adForm),
        timezoneId: Number(adForm.timezoneId) || 1,
        currency: adForm.currency,
        count: accountCount,
        createPixel,
        assignAdmin,
        adBilling: adBillingPayload(adForm),
      },
    }));
    try {
      const job = await submitJob({ type: 'create_adaccount', title: `创建广告号（${jobItems.length} 个 BM）`, items: jobItems });
      setResults([{
        bmId: '-',
        status: 'success',
        message: `已提交 ${jobItems.length} 个创建广告号任务到执行队列（${job.id}），进度见左侧「执行队列」`,
      }]);
    } catch (e: any) {
      setResults([{ bmId: '-', status: 'error', message: `提交失败: ${e?.message || e}` }]);
    } finally {
      setProcessing(false);
    }
  };

  // 🆕 创建像素：给「BM 名下全部广告号」或「手动指定的广告号」逐个建像素/数据集
  //    🧵 已统一走服务端队列：每个目标 BM 一个队列项，「先取广告号 → 再逐个建像素」的编排搬进后端 op，
  //       刷新/关弹窗不丢进度，也不会多个 BM 同时在前端开并发抢浏览器。
  const handleCreatePixel = () => {
    const manualIds = pixelAdAccountIds.split(/[\s,，;；]+/).map(s => s.trim().replace(/^act_/, '')).filter(Boolean);
    if (pixelScope === 'manual' && manualIds.length === 0) { alert('请输入至少一个广告号 ID，或改选「BM 名下全部广告号」'); return; }
    // 手动模式目标已指定，跟 BM 无关 → 只跑一次（用第一个选中配置的登录态），避免多 BM 时重复建
    const runItems = pixelScope === 'manual' ? items.slice(0, 1) : items;
    if (runItems.length === 0) { alert('没有可用的目标'); return; }

    const jobItems = runItems.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: {
        profileId: item.profileId,
        // 手动模式：直接给广告号列表；BM 模式：给 businessId，让后端自动拉该 BM 的 owned_ad_accounts
        ...(pixelScope === 'manual'
          ? { adAccountIds: manualIds }
          : { businessId: item.bmId, claimToBusiness: autoClaimPixel }),
        pixelName: pixelName.trim() || undefined,
      },
    }));
    void submitBmQueueJob('create_pixel', `创建像素（${jobItems.length} 项）`, jobItems);
  };

  const _splitIds = (s: string) => s.split(/[\s,，;；]+/).map(x => x.trim()).filter(Boolean);

  // 🆕 载入该 BM 名下广告号（供「关联广告号」下拉用）
  const handleLoadBmAdAccounts = async () => {
    const item = items[0];
    if (!item) { alert('没有可用的 BM'); return; }
    setLoadingBmAdAccounts(true);
    try {
      const r = await fetch(`${lbase}/api/facebook/businesses/refresh-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: item.profileId, businessId: item.bmId })
      });
      const j = await r.json().catch(() => ({}));
      if (!j.success) { alert(`拉取失败: ${j.message || j.error || '未知错误'}`); return; }
      const list = (Array.isArray(j.adAccounts) ? j.adAccounts : [])
        .map((a: any) => ({ id: String(a.accountId || a.id || '').replace(/^act_/, ''), name: String(a.name || '') }))
        .filter((a: any) => a.id);
      setBmAdAccounts(list);
      if (list.length === 0) alert(`BM ${item.bmId} 名下没有广告号`);
    } finally { setLoadingBmAdAccounts(false); }
  };

  // 🆕 载入该 BM 名下像素（认领过的像素会出现在这里）
  const handleLoadBmPixels = async () => {
    const item = items[0];
    if (!item) { alert('没有可用的 BM'); return; }
    setLoadingBmPixels(true);
    try {
      const r = await fetch(`${lbase}/api/facebook/pixels/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: item.profileId, businessId: item.bmId })
      });
      const j = await r.json().catch(() => ({}));
      if (!j.success) { alert(`拉取失败: ${j.message || j.error || '未知错误'}`); return; }
      const ids = (Array.isArray(j.pixels) ? j.pixels : []).map((p: any) => String(p.id || '')).filter(Boolean);
      if (ids.length === 0) { alert(`BM ${item.bmId} 名下没有已认领的像素`); return; }
      setGrantPixelIds(ids.join('\n'));
    } finally { setLoadingBmPixels(false); }
  };

  // 🆕 像素授权：分享给合作方 BM（/{pixel}/agencies）或 关联广告号（/{pixel}/shared_accounts）
  //    🧵 已统一走队列：mode 决定后端走哪个端点，结果明细由 op 拼进队列项消息
  const handleGrantPixels = () => {
    const pixels = _splitIds(grantPixelIds);
    if (pixels.length === 0) { alert('请先填写像素 ID（或点「载入该 BM 的像素」）'); return; }
    if (pixelGrantMode === 'partner' && !grantPartnerBmId.trim()) { alert('请填写合作方 BM ID'); return; }
    const acts = pixelGrantMode === 'adaccount' ? _splitIds(grantAdAccountIds).map(a => a.replace(/^act_/, '')) : [];
    if (pixelGrantMode === 'adaccount' && acts.length === 0) { alert('请填写广告号 ID（或点「载入该 BM 的广告号」后选择）'); return; }
    if (pixelGrantMode === 'partner' && grantTasks.length === 0) { alert('请至少勾选一项权限'); return; }

    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: pixelGrantMode === 'partner'
        ? { mode: 'partner', profileId: item.profileId, pixelIds: pixels, partnerBusinessId: grantPartnerBmId.trim(), tasks: grantTasks }
        : { mode: 'adaccount', profileId: item.profileId, businessId: item.bmId, pixelIds: pixels, adAccountIds: acts },
    }));
    void submitBmQueueJob('grant_pixels', `像素授权（${jobItems.length} 项）`, jobItems);
  };

  // 🧵 已统一走队列（原来是前端直连循环）
  const handleGrantPage = () => {
    if (!pageId) { alert('请输入主页ID'); return; }
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: { profileId: item.profileId, businessId: item.bmId, pageId },
    }));
    void submitBmQueueJob('grant_page', `授权主页（${jobItems.length} 个 BM）`, jobItems);
  };

  const handleFetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const item = items[0];
      const resp = await fetch(`${lbase}/api/facebook/businesses/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: item.profileId, businessId: item.bmId })
      });
      const json = await resp.json();
      if (json.success) {
        setUsersData(json);
        setSelectedUserIds(new Set());
      } else {
        alert(json.message || '获取用户列表失败');
      }
    } catch (err: any) {
      alert(`请求失败: ${err.message}`);
    }
    setLoadingUsers(false);
  };

  // 🆕 变更选中成员的角色（批量；Meta 一次一个，服务端逐个发）
  const handleBulkRole = async () => {
    const ids = Array.from(selectedUserIds);
    if (!ids.length) return alert('请先勾选成员');
    const targets = (usersData?.users || [])
      .filter((u: any) => ids.includes(String(u.id)))
      .map((u: any) => ({ id: String(u.id), name: u.name || u.email || '', role: bulkRole }));
    if (!targets.length) return alert('选中的成员里没有可改角色的（待接受邀请不能改角色）');
    setUsersBusy(true);
    try {
      const item = items[0];
      const resp = await fetch(`${lbase}/api/facebook/businesses/update-user-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: item.profileId, businessId: item.bmId, targets })
      });
      const json = await resp.json();
      const fails = (json.results || []).filter((r: any) => !r.ok);
      alert(`变更角色：成功 ${json.count || 0}/${json.total || targets.length}${fails.length ? `\n失败：\n${fails.map((f: any) => `${f.name || f.id}: ${f.message}`).join('\n')}` : ''}`);
      await handleFetchUsers();
      window.dispatchEvent(new Event('businesses-refresh'));
    } catch (e: any) { alert(`请求失败: ${e.message}`); }
    setUsersBusy(false);
  };

  // 🆕 移除选中成员（批量，活跃成员 + 待接受邀请都能移除）
  const handleRemoveUsers = async () => {
    const ids = Array.from(selectedUserIds);
    if (!ids.length) return alert('请先勾选成员');
    const all = [...(usersData?.users || []), ...(usersData?.pendingUsers || [])];
    const targets = all
      .filter((u: any) => ids.includes(String(u.id)))
      .map((u: any) => ({ id: String(u.id), name: u.name || '', email: u.email || '' }));
    if (!targets.length) return alert('没有可移除的成员');
    if (!confirm(`确定把选中的 ${targets.length} 个成员从 BM 移除？该操作在 Meta 侧立即生效。`)) return;
    setUsersBusy(true);
    try {
      const item = items[0];
      const resp = await fetch(`${lbase}/api/facebook/businesses/remove-users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
        body: JSON.stringify({ profileId: item.profileId, businessId: item.bmId, targets })
      });
      const json = await resp.json();
      const fails = (json.results || []).filter((r: any) => !r.ok);
      alert(`移除成员：成功 ${json.count || 0}/${json.total || targets.length}${fails.length ? `\n失败：\n${fails.map((f: any) => `${f.name || f.email || f.id}: ${f.message}`).join('\n')}` : ''}`);
      await handleFetchUsers();
      window.dispatchEvent(new Event('businesses-refresh'));
    } catch (e: any) { alert(`请求失败: ${e.message}`); }
    setUsersBusy(false);
  };

  // 🧵 已统一走队列：绑卡是 puppeteer 重活，入队后由后端借用浏览器并在完成后归还（不再常驻泄漏）
  const handleBindCard = () => {
    if (!adAccountId || !ccNumber || !ccYear || !ccMonth || !ccCVC) {
      alert('请填写完整的卡片信息');
      return;
    }
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: {
        profileId: item.profileId,
        adAccountId,
        ccNumber,
        ccYear,
        ccMonth,
        ccCVC,
        ccIso,
        currency: bindCurrency || undefined,
        timezone_id: bindTimezone || undefined,
      },
    }));
    void submitBmQueueJob('bind_card', `绑卡（${jobItems.length} 项）`, jobItems);
  };

  // 🧵 已统一走队列（原来是前端直连循环）
  const handleSharePartner = () => {
    if (!partnerBusinessId) { alert('请输入合作伙伴 BM ID'); return; }
    let ids: string[] = [];
    if (shareAdAccountIds.trim()) {
      ids = shareAdAccountIds.split(/[,;\s]+/).map(s => s.replace(/^act_/, '').trim()).filter(Boolean);
    }
    // 未输入广告号 ID → 交给后端从该 BM 的 owned_ad_accounts 自动拉取
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: ids.length === 0
        ? { profileId: item.profileId, businessId: item.bmId, partnerBusinessId, tasks: partnerTasks, autoFetchAdAccounts: true }
        : { profileId: item.profileId, adAccountIds: ids, partnerBusinessId, tasks: partnerTasks },
    }));
    void submitBmQueueJob('share_partner', `分享合作伙伴（${jobItems.length} 项）`, jobItems);
  };

  // 🆕 广告号授权到个人号 (传入 FB 用户 ID)
  // 对每个选中 BM,自动拉取 owned_ad_accounts 并授权给指定 FB 用户 ID,固定全权限
  // 🧵 已统一走队列（原来是前端直连循环）
  const handleAssignPersonalAd = () => {
    if (!personalFbUserId.trim()) { alert('请输入 FB 用户 ID'); return; }
    let ids: string[] = [];
    if (personalAdAccountIds.trim()) {
      ids = personalAdAccountIds.split(/[,;\s]+/).map(s => s.replace(/^act_/, '').trim()).filter(Boolean);
    }
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: ids.length === 0
        ? { profileId: item.profileId, businessId: item.bmId, fbUserId: personalFbUserId.trim(), autoFetchAdAccounts: true }
        : { profileId: item.profileId, adAccountIds: ids, fbUserId: personalFbUserId.trim() },
    }));
    void submitBmQueueJob('assign_personal_ad', `广告号授权个号（${jobItems.length} 项）`, jobItems);
  };

  // 🆕 主页授权到个人号 (传入 FB 用户 ID)
  // 对每个选中 BM,自动拉取 owned_pages 并授权给指定 FB 用户 ID,固定全权限
  // 🧵 已统一走队列（原来是前端直连循环）
  const handleGrantPersonalPage = () => {
    if (!personalFbUserId.trim()) { alert('请输入 FB 用户 ID'); return; }
    let ids: string[] = [];
    if (personalPageIds.trim()) {
      ids = personalPageIds.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    }
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: ids.length === 0
        ? { profileId: item.profileId, businessId: item.bmId, fbUserId: personalFbUserId.trim(), autoFetchPages: true }
        : { profileId: item.profileId, pageIds: ids, fbUserId: personalFbUserId.trim() },
    }));
    void submitBmQueueJob('grant_personal_page', `主页授权个号（${jobItems.length} 项）`, jobItems);
  };

  // 🆕 创建 BM — 与 AssetViewer 创建BM 表单逻辑统一
  // 对每个选中 profileId 按 bmCount 循环创建，支持随机名称、创建广告号、创建主页
  const handleCreateBM = async () => {
    if (!bmName) { alert('请输入 BM 名称'); return; }
    if (!bmEmail && !isRandomBMEmail) { alert('请输入邮箱'); return; }
    setProcessing(true);
    setResults([]);
    const newResults: Array<{ bmId: string; status: 'success' | 'error'; message: string }> = [];

    // 代理覆盖（createBM 走 /api/facebook/business/create，后端会用它切浏览器代理）
    let proxyOverride: any = undefined;
    if (selectedProxyId) {
      proxyOverride = proxyList.find(px => px.id === selectedProxyId);
    } else if (proxyManualInput.trim()) {
      const raw = proxyManualInput.trim();
      let host = '', port = '', username = '', password = '';
      let rest = raw;
      const m = raw.match(/^(https?|socks5):\/\//i);
      if (m) { rest = raw.replace(/^(https?|socks5):\/\//i, ''); }
      if (rest.includes('@')) {
        const [cred, hostpart] = rest.split('@');
        const [u, p] = cred.split(':');
        username = u || ''; password = p || '';
        const [h, pt] = hostpart.split(':');
        host = h || ''; port = pt || '';
      } else {
        const parts = rest.split(':');
        if (parts.length === 2) { host = parts[0]; port = parts[1]; }
        if (parts.length === 4) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3]; }
      }
      if (host && port) {
        proxyOverride = { type: proxyType, host, port, username, password };
      }
    }

    // 🧵 走服务端队列（与配置管理页的「创建BM」统一）：前端只提交任务，
    //    执行/并发/进度/取消都在后端，刷新或切页都不会中断。
    //    每个「配置 × BM 创建数量」一个队列项。
    const jobItems: Array<{ key: string; label: string; payload: any }> = [];
    for (const item of items) {
      for (let i = 0; i < bmCount; i++) {
        const currentBMName = isRandomBMName ? genRandomBMName() : bmName;
        const payload: any = {
          profileId: item.profileId,
          name: currentBMName,
          email: isRandomBMEmail ? undefined : bmEmail,
          bmCount: 1,
          createAdAccount: bmCreateAdAccount,
          createPage: bmCreatePage,
          defaultPageName: bmDefaultPageName || undefined,
          country: bmCountry || undefined,
          // 📧 建完自动生成邀请链接（每个 BM N 个）；0/未勾选 = 不生成
          inviteCount: bmInviteEnabled ? bmInviteCount : 0,
          // 🛒 邀请链接生成后自动上架商城（勾选时透传）
          shopPublish: bmInviteEnabled ? bmShopPublish : false,
          shopPrice: bmShopPrice,
          shopCurrency: 'USDT',
          // 🆕 广告号时区/货币：create_bm_bundle 建广告号时要用（以前没传 → 后端回落成 GMT-11）
          timezoneId: Number(adForm.timezoneId) || 1,
          currency: adForm.currency,
        };
        // 勾选了创建广告号时：广告号单独命名（手填/随机/时间戳）+ 数量 + 账单信息
        if (bmCreateAdAccount) {
          payload.adAccountCount = bmAdAccountCount;
          Object.assign(payload, adNamePayload(adForm));
          payload.adBilling = adBillingPayload(adForm);
        }
        // 🆕 名字 / 姓氏各可勾选「用配置 ID」：填该配置自己的 profileId
        const fn = useProfileIdFirstName ? String(item.profileId) : bmFirstName;
        const ln = useProfileIdLastName ? String(item.profileId) : bmLastName;
        if (fn) payload.firstName = fn;
        if (ln) payload.lastName = ln;
        if (proxyOverride) payload.proxyOverride = proxyOverride;
        jobItems.push({ key: `${item.profileId}#${i + 1}`, label: `${item.profileId} / ${currentBMName}`, payload });
      }
    }

    // 🔓 仅配置模式：不提交任务，把这份构造好的任务交回调用方。
    //    智能发布的「创建BM」步骤就是这么拿到配置的 —— 表单和提交给后端的 payload
    //    都还是这一份，只是目的地从「队列」换成了「调用方」。
    if (configureOnly) {
      if (onSaveConfig) onSaveConfig({ type: 'create_bm_bundle', title: `创建BM（${jobItems.length} 个）`, items: jobItems });
      setProcessing(false);
      onClose();
      return;
    }

    // 🔗 联动：勾选「建完自动获取信息」→ 把获取信息作为同 job 的追加项（项级 type=get_info），
    //    与创建项同 job 串行执行；服务端同 job 的 hasNextForProfile 查得到它，
    //    创建项完成时浏览器保留 → 获取信息直接复用，不再冷启动。configureOnly（智能发布）模式不追加。
    if (bmAutoFetchInfo) {
      const infoPids = Array.from(new Set(items.map((it: any) => String(it.profileId))));
      for (const pid of infoPids) {
        jobItems.push({
          key: `${pid}#bmauto`,
          label: `${pid}（创建后自动获取信息）`,
          type: 'get_info',
          payload: { profileId: pid, accessToken: 'BROWSER', withAccountQuality: true },
        } as any);
      }
    }

    try {
      const job = await submitJob({ type: 'create_bm_bundle', title: `创建BM（${jobItems.filter((j: any) => !String(j.key || '').endsWith('#bmauto')).length} 个）`, items: jobItems });
      newResults.push({
        bmId: '-',
        status: 'success',
        message: `已提交 ${jobItems.length} 个任务到执行队列（${job.id}，含自动获取信息项）。执行/进度/取消见左侧「执行队列」，可放心刷新或切页。`,
      });
      // 🔗 勾了「建完自动获取信息」：等任务跑完，把涉及的配置 ID 交给调用方落位到本地缓存
      //    （服务端队列已抓完并同步云端，但 localStorage 缓存只有前端能写）。
      if (job && bmAutoFetchInfo && onFetchedAssets) {
        const infoPids = Array.from(new Set(jobItems
          .filter((j: any) => String(j.type || '') === 'get_info')
          .map((j: any) => String(j.payload?.profileId || ''))
          .filter(Boolean)));
        if (infoPids.length) {
          void (async () => {
            try { await waitForJob(job.id, () => {}); } catch {}
            try { onFetchedAssets(infoPids); } catch {}
          })();
        }
      }
    } catch (err: any) {
      newResults.push({ bmId: '-', status: 'error', message: `提交失败: ${err?.message || err}` });
    }

    setResults(newResults);
    setProcessing(false);
  };

  // 🆕 BM 认证 — 调用 /api/facebook/businesses/verify-puppeteer
  // 手动触发，对单个 BM 提交业务认证（文件验证方式）
  // 🧵 已统一走队列：BM 认证是 puppeteer 重活（上传文件 + 填表），入队后由后端借用浏览器并在完成后归还
  const handleVerifyBM = () => {
    if (!verifyLegalName) { alert('请输入法律实体名称'); return; }
    if (verifyDocs.length === 0) { alert('请至少上传一份认证文件（营业执照等）'); return; }
    const targetBmId = (verifyBmId || items[0]?.bmId || '').trim();
    const targetProfileId = (verifyProfileId || items[0]?.profileId || '').trim();
    if (!targetBmId || !targetProfileId) { alert('缺少 BM ID 或 Profile ID'); return; }

    // 代理覆盖（复用现有逻辑）
    let proxyOverride: any = undefined;
    if (selectedProxyId) {
      proxyOverride = proxyList.find(px => px.id === selectedProxyId);
    } else if (proxyManualInput.trim()) {
      const raw = proxyManualInput.trim();
      let host = '', port = '', username = '', password = '';
      let rest = raw;
      const m = raw.match(/^(https?|socks5):\/\//i);
      if (m) { rest = raw.replace(/^(https?|socks5):\/\//i, ''); }
      if (rest.includes('@')) {
        const [cred, hostpart] = rest.split('@');
        const [u, p] = cred.split(':');
        username = u || ''; password = p || '';
        const [h, pt] = hostpart.split(':');
        host = h || ''; port = pt || '';
      } else {
        const parts = rest.split(':');
        if (parts.length === 2) { host = parts[0]; port = parts[1]; }
        if (parts.length === 4) { host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3]; }
      }
      if (host && port) {
        proxyOverride = { type: proxyType, host, port, username, password };
      }
    }

    const payload: any = {
      profileId: targetProfileId,
      bmId: targetBmId,
      legalName: verifyLegalName,
      businessType: verifyBusinessType,
      documents: verifyDocs,
    };
    if (verifyLegalAddress) payload.legalAddress = verifyLegalAddress;
    if (verifyPhone) payload.phoneNumber = verifyPhone;
    if (verifyWebsite) payload.website = verifyWebsite;
    if (proxyOverride) payload.proxyOverride = proxyOverride;

    void submitBmQueueJob('verify_bm', `BM认证（${targetBmId}）`, [{ key: targetBmId, label: targetBmId, payload }]);
  };

  // 🆕 刷新 BM 信息 — 调用 /api/facebook/businesses/refresh-info
  //    🧵 已统一走队列：明细（名称/认证/广告号/主页）由后端 op 拼进队列项消息
  const handleRefreshInfo = () => {
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: { profileId: item.profileId, businessId: item.bmId },
    }));
    void submitBmQueueJob('refresh_info', `刷新信息（${jobItems.length} 个 BM）`, jobItems);
  };

  // 🆕 同步所有权限 — 调用 /api/facebook/businesses/sync-permissions
  //    🧵 已统一走队列：成功/失败明细由后端 op 拼进队列项消息
  const handleSyncPermissions = () => {
    const jobItems = items.map((item) => ({
      key: `${item.profileId}::${item.bmId}`,
      label: `${item.profileId} / ${item.bmId}`,
      payload: { profileId: item.profileId, businessId: item.bmId },
    }));
    void submitBmQueueJob('sync_permissions', `同步权限（${jobItems.length} 个 BM）`, jobItems);
  };

  // 🆕 文件转 base64
  const fileToBase64 = (file: File): Promise<{ filename: string; mimeType: string; base64: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64: String(reader.result || '')
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleVerifyDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const newDocs = await Promise.all(files.map(fileToBase64));
    setVerifyDocs(prev => [...prev, ...newDocs]);
  };

  const removeVerifyDoc = (idx: number) => {
    setVerifyDocs(prev => prev.filter((_, i) => i !== idx));
  };

  const tabs: Array<{ key: TabType; label: string; icon: React.ElementType }> = [
    { key: 'invite', label: '邀请用户', icon: UserPlus },
    { key: 'createAccount', label: '创建广告号', icon: Briefcase },
    { key: 'createBM', label: '创建BM', icon: Building2 },
    { key: 'createPixel', label: '创建像素', icon: Target },
    { key: 'pixelGrant', label: '像素授权', icon: Share2 },
    { key: 'sharePartner', label: '分享合作伙伴', icon: Share2 },
    { key: 'assignPersonalAd', label: '广告号授权个号', icon: UserCheck },
    { key: 'grantPage', label: '授权主页', icon: Globe },
    { key: 'grantPersonalPage', label: '主页授权个号', icon: UserCheck },
    { key: 'users', label: '用户列表', icon: Users },
    { key: 'bindCard', label: '绑卡', icon: CreditCard },
    { key: 'verifyBM', label: 'BM认证', icon: ShieldCheck },
    { key: 'refreshInfo', label: '刷新信息', icon: RefreshCw },
    { key: 'syncPermissions', label: '同步权限', icon: Shield },
  ];
  // 🔓 仅配置模式只暴露指定的那一个 tab：避免在别人的流程里还能点出「绑卡」「邀请用户」这类会立刻执行的动作
  const visibleTabs = configureOnly ? tabs.filter(t => t.key === (initialTab || 'createBM')) : tabs;

  // 🚀 代理中心：标签/渠道聚合 + 过滤
  const renderForm = () => {
    const proxySelector = (
      <div className="mb-4 p-3 bg-slate-800/50 border border-slate-700 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Server className="w-4 h-4 text-slate-400" />
          <span className="text-sm text-slate-300">代理覆盖（调用代理中心，不保存）</span>
          <button
            type="button"
            onClick={async () => {
              // 🚀 强制刷新代理列表
              try {
                const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
                const base = String(serverUrl || '').replace(/\/$/, '');
                const authToken = localStorage.getItem('auth_token');
                if (!authToken) return;
                const r = await fetch(`${base}/api/proxies`, {
                  headers: { 'Authorization': `Bearer ${authToken}` }
                });
                if (!r.ok) return;
                const j = await r.json();
                const list = Array.isArray(j?.data) ? j.data : [];
                setProxyList(list);
                try { localStorage.setItem('proxy-list', JSON.stringify(list)); } catch {}
              } catch {}
            }}
            className="ml-auto px-2 py-0.5 text-[10px] bg-indigo-700 hover:bg-indigo-600 text-white rounded flex items-center gap-1"
            title="从服务器刷新代理列表"
          >
            <RefreshCw className="w-3 h-3" /> 刷新
          </button>
          <button
            type="button"
            onClick={() => { setProxyManualInput(''); setSelectedProxyId(''); }}
            className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
          >
            清除
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <select
            value={selectedProxyId}
            onChange={e => { setSelectedProxyId(e.target.value); if (e.target.value) setProxyManualInput(''); }}
            className="col-span-2 bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
          >
            <option value="">-- 使用配置自带代理 --</option>
            {proxyList.filter(p => p).map(px => (
              <option key={px.id} value={px.id}>
                {px.name || px.remark || px.label || px.host?.substring(0, 12) || px.id?.substring(0, 8)} ({px.host}:{px.port})
              </option>
            ))}
          </select>
          <select
            value={proxyType}
            onChange={e => setProxyType(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-2 rounded text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
          >
            <option value="http">HTTP</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </div>
        <input
          value={proxyManualInput}
          onChange={e => { setProxyManualInput(e.target.value); if (e.target.value) setSelectedProxyId(''); }}
          placeholder="或手动输入代理: host:port 或 user:pass@host:port"
          className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
        />
        <div className="mt-1 flex justify-between text-[10px] text-slate-500">
          <span>{selectedProxyId ? '已选代理中心代理' : proxyManualInput ? '手动输入代理' : '未覆盖（使用配置自带代理）'}</span>
          <span>{proxyList.length} 个可用代理</span>
        </div>
      </div>
    );

    switch (activeTab) {
      case 'invite':
        return (
          <div className="space-y-4">
            {proxySelector}
            {/* 📧 两种模式：手动填邮箱发邀请 / 自动生成 N 个邀请链接 */}
            <div className="flex gap-2 p-1 bg-slate-950 border border-slate-700 rounded">
              <button type="button" onClick={() => setInviteAuto(false)}
                className={`flex-1 px-3 py-1.5 rounded text-sm ${!inviteAuto ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>手动填写邮箱</button>
              <button type="button" onClick={() => setInviteAuto(true)}
                className={`flex-1 px-3 py-1.5 rounded text-sm ${inviteAuto ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>自动生成邀请链接</button>
            </div>
            {inviteAuto ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-300 text-sm mb-1">每个 BM 生成数量</label>
                  <input type="number" min={1} max={10} value={inviteAutoCount}
                    onChange={e => setInviteAutoCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                </div>
                {/* 🏬 写入商城商品（可选）：整批共用一个商品 */}
                <div className="p-3 bg-slate-800/40 border border-slate-700 rounded-lg space-y-3">
                  <div className="text-xs text-slate-400">
                    写入商城商品（可选）—— 整批共用一个商品：链接按「BMID + 该 BM 的各条链接」分组写入商品，
                    商品数量 = 实际生成成功的 BM 组数
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-1">归属板块</label>
                    <select value={inviteBlockId} onChange={e => setInviteBlockId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm">
                      <option value="">未分组（选已有商品时沿用其原板块）</option>
                      {shopBlocks.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-1">商品标题</label>
                    <select value={inviteProductPick} onChange={e => setInviteProductPick(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm">
                      <option value="__none__">不写入商品（只生成链接）</option>
                      <option value="__new__">＋ 新建商品…</option>
                      {shopProducts.map(p => (
                        <option key={p.id} value={p.id}>
                          #{p.id} {p.title}{p.block_id ? `（${(shopBlocks.find(b => String(b.id) === String(p.block_id)) || {}).title || `块${p.block_id}`}）` : ''}
                        </option>
                      ))}
                    </select>
                    {inviteProductPick === '__new__' && (
                      <input value={inviteNewTitle} onChange={e => setInviteNewTitle(e.target.value)}
                        placeholder="新商品标题（必填）"
                        className="mt-2 w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded text-sm" />
                    )}
                    {inviteProductPick !== '__none__' && (
                      <p className="text-xs text-amber-400/80 mt-1">
                        {inviteProductPick === '__new__' ? '将新建商品并写入' : `将覆盖商品 #${inviteProductPick} 的邀请链接`}；
                        已有商品的价格 / 描述 / 状态等原字段保持不变。
                      </p>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  为每个选中的 BM 生成 N 个邀请链接：后台自动生成临时邮箱 → 发出邀请 → 收信提取链接 → 写回 BM 列表。
                  指定商品后整批会合成**一个**队列项串行执行（多 BM 并发写同一商品会互相覆盖）。
                  ⚠️ 每个链接需轮询收信最长 45s，慢操作，已放入执行队列后台跑。
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-slate-300 text-sm mb-1">
                  邮箱地址 <span className="text-slate-500 font-normal">(一行一个，可批量)</span>
                </label>
                <textarea value={email} onChange={e => setEmail(e.target.value)}
                  placeholder={'user1@example.com\nuser2@example.com'}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none min-h-[84px] resize-none text-sm font-mono" />
                <p className="text-xs text-slate-500 mt-1">换行 / 逗号 / 分号分隔都行；会按邮箱个数依次发送邀请，重复的自动去重。</p>
              </div>
            )}
            <div>
              <label className="block text-slate-300 text-sm mb-1">角色</label>
              <select value={role} onChange={e => setRole(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none">
                <option value="EMPLOYEE">Employee (员工)</option>
                <option value="ADMIN">Admin (管理员)</option>
              </select>
            </div>
            <button onClick={inviteAuto ? handleInviteLinks : handleInvite} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {inviteAuto ? `生成邀请链接（每个 BM ${inviteAutoCount} 个）` : '发送邀请'}
            </button>
          </div>
        );

      case 'createAccount':
        return (
          <div className="space-y-4">
            {proxySelector}
            {adAccountFields('输入广告号名称')}
            {/* 时区 / 货币已并入上面的 adAccountFields（与「创建 BM」入口共用同一份） */}
            <div>
              <label className="block text-slate-300 text-sm mb-1">创建数量</label>
              <input type="number" min={1} max={20} value={accountCount}
                onChange={e => setAccountCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div className="flex gap-4">
              <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                <input type="checkbox" checked={assignAdmin} onChange={e => setAssignAdmin(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                自动授权管理员
              </label>
              <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                <input type="checkbox" checked={createPixel} onChange={e => setCreatePixel(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                自动创建像素
              </label>
            </div>
            <button onClick={handleCreateAccount} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />}
              创建广告号
            </button>
          </div>
        );

      case 'createBM':
        return (
          <div className="space-y-4">
            {/* 目标数量提示 */}
            <div className="text-slate-300 text-sm">目标数量：<span className="font-mono text-slate-200">{items.length}</span></div>

            {/* BM 名称 + 随机生成 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">BM 名称 <span className="text-rose-400">*</span></label>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isRandomBMName}
                    onChange={(e) => {
                      setIsRandomBMName(e.target.checked);
                      if (e.target.checked) setBmName(genRandomBMName());
                    }}
                    className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600"
                  />
                  随机生成
                </label>
              </div>
              <div className="flex gap-2">
                <input value={bmName} onChange={e => {
                  setBmName(e.target.value);
                  if (isRandomBMName) setIsRandomBMName(false);
                }}
                  placeholder="输入 BM 名称或勾选随机生成"
                  className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                {isRandomBMName && (
                  <button type="button" onClick={() => setBmName(genRandomBMName())}
                    title="换一个"
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded text-sm shrink-0 flex items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5" /> 换
                  </button>
                )}
              </div>
            </div>

            {/* 国家（可选） */}
            <div>
              <label className="block text-slate-300 text-sm mb-1">国家 <span className="text-slate-500 text-xs">(可选，BM 创建时用；广告号账单国家在下方「账单信息」里填)</span></label>
              <input value={bmCountry} onChange={e => setBmCountry(e.target.value)}
                placeholder="例如 US, GB, CA（留空使用账号配置）"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>

            {/* 邮箱 + 随机按钮（与「批量操作」创建BM表单一致） */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 text-sm">邮箱 <span className="text-rose-400">*</span></label>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                  <input type="checkbox" checked={isRandomBMEmail}
                    onChange={e => { setIsRandomBMEmail(e.target.checked); if (e.target.checked) setBmEmail(''); }}
                    className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                  后台自动生成长随机邮箱
                </label>
              </div>
              <div className="flex gap-2">
                <input value={bmEmail} onChange={e => setBmEmail(e.target.value)}
                  placeholder={isRandomBMEmail ? '后台自动生成' : 'user@example.com'}
                  disabled={isRandomBMEmail}
                  className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
                <button type="button" onClick={() => setBmEmail(generateRandomEmail())} disabled={isRandomBMEmail}
                  title="随机生成邮箱"
                  className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm shrink-0 flex items-center gap-1 disabled:opacity-40">
                  🎲 <span className="text-xs">随机</span>
                </button>
              </div>
            </div>

            {/* 名字 / 姓氏（可选；各自可勾选「用配置 ID」） */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-300 text-sm">名字 <span className="text-slate-500 text-xs">(可选)</span></label>
                  <label className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer select-none">
                    <input type="checkbox" checked={useProfileIdFirstName}
                      onChange={e => setUseProfileIdFirstName(e.target.checked)}
                      className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                    用配置 ID
                  </label>
                </div>
                <input value={useProfileIdFirstName ? '' : bmFirstName} onChange={e => setBmFirstName(e.target.value)}
                  disabled={useProfileIdFirstName}
                  placeholder={useProfileIdFirstName ? '该配置的 ID' : 'John'}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-300 text-sm">姓氏 <span className="text-slate-500 text-xs">(可选)</span></label>
                  <label className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer select-none">
                    <input type="checkbox" checked={useProfileIdLastName}
                      onChange={e => setUseProfileIdLastName(e.target.checked)}
                      className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                    用配置 ID
                  </label>
                </div>
                <input value={useProfileIdLastName ? '' : bmLastName} onChange={e => setBmLastName(e.target.value)}
                  disabled={useProfileIdLastName}
                  placeholder={useProfileIdLastName ? '该配置的 ID' : 'Doe'}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-40" />
              </div>
            </div>

            {/* 创建数量 + 创建广告号 + 创建主页 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 text-sm mb-1">BM 创建数量</label>
                <input type="number" min={1} max={10} value={bmCount}
                  onChange={e => setBmCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div className="space-y-2 pt-5">
                <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                  <input type="checkbox" checked={bmCreateAdAccount} onChange={e => setBmCreateAdAccount(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建广告号
                </label>
                <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                  <input type="checkbox" checked={bmCreatePage} onChange={e => setBmCreatePage(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600" />创建主页
                </label>
              </div>
            </div>
            {bmCreateAdAccount && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 text-sm mb-1">广告号数量 <span className="text-slate-500 text-xs">(每个 BM)</span></label>
                    <input type="number" min={1} max={20} value={bmAdAccountCount}
                      onChange={e => setBmAdAccountCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                  </div>
                  <div className="pt-7 text-xs text-slate-500">
                    共 {bmCount} 个 BM × {bmAdAccountCount} 个广告号 = {bmCount * bmAdAccountCount} 个广告号
                  </div>
                </div>
                {adAccountFields('留空则沿用 BM 名称')}
              </>
            )}
            {bmCreatePage && (
              <div>
                <label className="block text-slate-300 text-sm mb-1">默认主页名称 <span className="text-slate-500 text-xs">(可选)</span></label>
                <input value={bmDefaultPageName} onChange={e => setBmDefaultPageName(e.target.value)}
                  placeholder="留空则使用 BM名称-Page-序号"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
            )}

            {/* 📧 建完自动生成邀请链接 */}
            <div className="space-y-2">
              <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                <input type="checkbox" checked={bmInviteEnabled} onChange={e => setBmInviteEnabled(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600" />建完自动生成邀请链接
              </label>
              {bmInviteEnabled && (
                <div>
                  <label className="block text-slate-300 text-sm mb-1">每个 BM 邀请链接数量</label>
                  <input type="number" min={1} max={10} value={bmInviteCount}
                    onChange={e => setBmInviteCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                  <p className="text-xs text-slate-500 mt-1">
                      每个新建的 BM 自动生成 N 个邀请链接（临时邮箱→邀请→收信提取→写回 BM 列表）。
                       ⚠️ 每个链接需轮询收信最长 45s，会明显拉长该项耗时，已放入执行队列后台跑。
                    </p>
                    {/* 🛒 生成后自动上架商城（联动） */}
                    <label className="inline-flex items-center gap-2 text-slate-300 text-sm mt-2">
                      <input type="checkbox" checked={bmShopPublish} onChange={e => setBmShopPublish(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-800 text-indigo-600" />生成后自动上架商城
                    </label>
                    {bmShopPublish && (
                      <div className="mt-1">
                        <label className="block text-slate-300 text-sm mb-1">商品价格（USDT）</label>
                        <input type="number" min={0} step={0.5} value={bmShopPrice}
                          onChange={e => setBmShopPrice(Math.max(0, Number(e.target.value) || 0))}
                          className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                        <p className="text-xs text-slate-500 mt-1">
                          每个 BM 一个商品，链接作为可发货条目追加；同一 BM 重复上架只追加新链接，不产生重复商品。
                        </p>
                      </div>
                    )}
                </div>
              )}
            </div>

            {/* 🔗 建完自动获取信息 */}
            <div className="space-y-2">
              <label className="inline-flex items-center gap-2 text-slate-300 text-sm">
                <input type="checkbox" checked={bmAutoFetchInfo} onChange={e => setBmAutoFetchInfo(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600" />建完自动获取信息
              </label>
              <p className="text-xs text-slate-500">
                全部 BM 建完后，自动对涉及的配置追加一次「获取信息」队列任务，广告号数量、BM 状态、创建时间等立即填充，无需手动再跑。
              </p>
            </div>

            {/* 代理选择器 */}
            {proxySelector}

            <p className="text-xs text-slate-400">
              将对每个选中的 Profile 按"BM 创建数量"循环创建 BM；勾选"创建广告号"后，每个 BM 再按"广告号数量"创建对应个数的广告号。调用 <code className="text-slate-300">/api/facebook/business/create</code> 接口，需确保浏览器已登录 Facebook。勾选"随机生成"时每个 BM 使用不同随机名称。广告号名称按上面的命名方式在「执行时」生成，填了账单信息则在广告号创建成功后自动写入（较慢，个别账号可能写入失败，不影响广告号创建）。
            </p>
            <button onClick={handleCreateBM} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
              {configureOnly ? '保存配置（不立刻创建）' : '创建 BM'}
            </button>
          </div>
        );

      case 'createPixel':
        return (
          <div className="space-y-4">
            <div className="bg-sky-900/20 border border-sky-800/50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Target className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-sky-300">创建像素（数据集）</h4>
                  <p className="text-xs text-sky-400/80 mt-1">
                    给广告号创建 Pixel / Dataset。Meta v21+ 下会先试 <code>adspixels</code>，接口不存在时自动切 <code>datasets</code>。
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-slate-300 text-sm mb-1">目标广告号</label>
              <div className="flex items-center gap-4 text-sm text-slate-300 mb-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={pixelScope === 'bm'} onChange={() => setPixelScope('bm')}
                    className="w-3.5 h-3.5 border-slate-600 bg-slate-800 text-indigo-600" />
                  BM 名下全部广告号（{items.length} 个 BM）
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={pixelScope === 'manual'} onChange={() => setPixelScope('manual')}
                    className="w-3.5 h-3.5 border-slate-600 bg-slate-800 text-indigo-600" />
                  手动指定
                </label>
              </div>
              {pixelScope === 'manual' && (
                <>
                  <textarea value={pixelAdAccountIds} onChange={e => setPixelAdAccountIds(e.target.value)}
                    rows={3} placeholder="广告号 ID，多个用换行/逗号分隔（act_ 前缀可省略）"
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm" />
                  <p className="text-xs text-amber-400/80 mt-1">手动模式只执行一次，使用第一个选中配置（{items[0]?.profileId || '-'}）的登录态。</p>
                </>
              )}
            </div>

            <div>
              <label className="block text-slate-300 text-sm mb-1">像素名称</label>
              <input value={pixelName} onChange={e => setPixelName(e.target.value)}
                placeholder="留空则按 pixel_<广告号ID> 命名"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>

            {pixelScope === 'bm' && (
              <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={autoClaimPixel} onChange={e => setAutoClaimPixel(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                <span>
                  创建后自动认领到该 BM
                  <span className="block text-xs text-slate-500 mt-0.5">
                    认领后像素归该 BM 所有，BM 里的管理员用户随即可完全控制它（Meta 官方 <code>POST /{'{'}business-id{'}'}/owned_pixels</code>）
                  </span>
                </span>
              </label>
            )}

            <button onClick={handleCreatePixel} disabled={processing}
              className="w-full px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />}
              创建像素
            </button>
          </div>
        );

      case 'pixelGrant': {
        const TASK_OPTIONS: Array<[string, string]> = [
          ['ANALYZE', '分析 / 投放'],
          ['UPLOAD', '上传事件'],
          ['ADVERTISE', '绑定广告号'],
          ['EDIT', '编辑数据集（需 Meta 白名单）'],
        ];
        return (
          <div className="space-y-4">
            <div className="bg-violet-900/20 border border-violet-800/50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Share2 className="w-5 h-5 text-violet-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-violet-300">像素授权</h4>
                  <p className="text-xs text-violet-400/80 mt-1">
                    分享给合作方 BM（Meta 会按合作关系直接生效或生成一条待对方接受的共享协议），
                    或把像素关联到广告号（广告号才能用这个像素投放）。
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-slate-300 text-sm mb-1">用途</label>
              <div className="flex items-center gap-4 text-sm text-slate-300">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={pixelGrantMode === 'partner'} onChange={() => setPixelGrantMode('partner')}
                    className="w-3.5 h-3.5 border-slate-600 bg-slate-800 text-indigo-600" />
                  分享给合作方 BM
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={pixelGrantMode === 'adaccount'} onChange={() => setPixelGrantMode('adaccount')}
                    className="w-3.5 h-3.5 border-slate-600 bg-slate-800 text-indigo-600" />
                  关联广告号
                </label>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 text-sm">像素 ID</label>
                <button type="button" onClick={handleLoadBmPixels} disabled={loadingBmPixels}
                  className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded flex items-center gap-1 disabled:opacity-50">
                  {loadingBmPixels ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  载入该 BM 的像素
                </button>
              </div>
              <textarea value={grantPixelIds} onChange={e => setGrantPixelIds(e.target.value)}
                rows={3} placeholder="像素 ID，多个用换行/逗号分隔"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm" />
              <p className="text-xs text-slate-500 mt-1">只列该 BM <b>已认领</b>的像素；没有就先去「创建像素」并勾选自动认领。</p>
            </div>

            {pixelGrantMode === 'partner' ? (
              <>
                <div>
                  <label className="block text-slate-300 text-sm mb-1">合作方 BM ID</label>
                  <input value={grantPartnerBmId} onChange={e => setGrantPartnerBmId(e.target.value)}
                    placeholder="接收像素访问权限的商务管理平台 ID"
                    className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
                  <p className="text-xs text-amber-400/80 mt-1">对方还没和你建立合作关系时，Meta 只会生成一条共享协议，等对方在自家 BM 里接受后才生效。</p>
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-1">授予权限</label>
                  <div className="grid grid-cols-2 gap-2">
                    {TASK_OPTIONS.map(([val, label]) => (
                      <label key={val} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={grantTasks.includes(val)}
                          onChange={e => setGrantTasks(prev => e.target.checked ? [...prev, val] : prev.filter(t => t !== val))}
                          className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-300 text-sm">广告号</label>
                  <button type="button" onClick={handleLoadBmAdAccounts} disabled={loadingBmAdAccounts}
                    className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded flex items-center gap-1 disabled:opacity-50">
                    {loadingBmAdAccounts ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    载入该 BM 的广告号
                  </button>
                </div>
                {bmAdAccounts.length > 0 && (
                  <div className="flex gap-2 mb-2">
                    <select value="" onChange={e => {
                      const v = e.target.value;
                      if (!v) return;
                      setGrantAdAccountIds(prev => _splitIds(prev).includes(v) ? prev : `${_splitIds(prev).join('\n')}${prev.trim() ? '\n' : ''}${v}`);
                    }}
                      className="flex-1 bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs focus:ring-2 focus:ring-indigo-500 outline-none">
                      <option value="">从该 BM 的 {bmAdAccounts.length} 个广告号中选择…</option>
                      {bmAdAccounts.map(a => <option key={a.id} value={a.id}>{a.id}{a.name ? ` — ${a.name}` : ''}</option>)}
                    </select>
                    <button type="button" onClick={() => setGrantAdAccountIds(bmAdAccounts.map(a => a.id).join('\n'))}
                      className="px-2 py-1.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded shrink-0">
                      全部加入
                    </button>
                  </div>
                )}
                <textarea value={grantAdAccountIds} onChange={e => setGrantAdAccountIds(e.target.value)}
                  rows={3} placeholder="广告号 ID，多个用换行/逗号分隔（act_ 前缀可省略）"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm" />
                <p className="text-xs text-slate-500 mt-1">按每个 BM 各自的广告号执行；像素必须归该 BM 所有（先认领）。</p>
              </div>
            )}

            <button onClick={handleGrantPixels} disabled={processing}
              className="w-full px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              {pixelGrantMode === 'partner' ? '分享给合作方 BM' : '关联到广告号'}
            </button>
          </div>
        );
      }

      case 'grantPage':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-slate-300 text-sm mb-1">主页 ID</label>
              <input value={pageId} onChange={e => setPageId(e.target.value)}
                placeholder="输入 Facebook Page ID"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <p className="text-xs text-slate-400">将所选主页授权给选中的 BM。主页需要存在于用户的 Graph API 可见范围内。</p>
            <button onClick={handleGrantPage} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
              授权给BM
            </button>
          </div>
        );

      case 'users': {
        const userIds = [
          ...((usersData?.users || []).map((u: any) => String(u.id))),
          ...((usersData?.pendingUsers || []).map((u: any) => String(u.id))),
        ];
        const allChecked = userIds.length > 0 && userIds.every((id) => selectedUserIds.has(id));
        const toggleUser = (id: string) => setSelectedUserIds((prev) => {
          const n = new Set(prev);
          if (n.has(id)) n.delete(id); else n.add(id);
          return n;
        });
        return (
          <div className="space-y-4">
            {proxySelector}
            {!usersData && (
              <button onClick={handleFetchUsers} disabled={loadingUsers}
                className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
                {loadingUsers ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
                加载用户列表
              </button>
            )}
            {usersData && (
              <div className="space-y-4">
                <div className="text-slate-200 text-sm font-medium">BM: {usersData.business?.name || items[0]?.bmId}</div>
                {/* 🆕 批量操作条：全选 / 改角色 / 移除 */}
                <div className="flex flex-wrap items-center gap-2 bg-slate-950 border border-slate-800 rounded px-3 py-2">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={allChecked}
                      onChange={(e) => setSelectedUserIds(e.target.checked ? new Set(userIds) : new Set())} />
                    全选（已选 {selectedUserIds.size}）
                  </label>
                  <div className="flex-1" />
                  <select value={bulkRole} onChange={(e) => setBulkRole(e.target.value as 'ADMIN' | 'EMPLOYEE')}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200">
                    <option value="ADMIN">Admin (管理员)</option>
                    <option value="EMPLOYEE">Employee (员工)</option>
                  </select>
                  <button onClick={handleBulkRole} disabled={usersBusy || !selectedUserIds.size}
                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded text-xs flex items-center gap-1">
                    {usersBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserCog className="w-3 h-3" />}变更权限
                  </button>
                  <button onClick={handleRemoveUsers} disabled={usersBusy || !selectedUserIds.size}
                    className="px-3 py-1 bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-white rounded text-xs flex items-center gap-1">
                    {usersBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}移除
                  </button>
                </div>
                {usersData.users?.length > 0 && (
                  <div>
                    <h4 className="text-slate-300 text-sm mb-2">已加入用户 ({usersData.users.length})</h4>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {usersData.users.map((u: any) => (
                        <div key={u.id} className="flex items-center justify-between bg-slate-950 rounded px-3 py-1.5 text-sm">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={selectedUserIds.has(String(u.id))} onChange={() => toggleUser(String(u.id))} />
                            <span className="text-slate-200">{u.name || u.email}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${u.role === 'ADMIN' ? 'bg-indigo-600/30 text-indigo-300' : 'bg-slate-700 text-slate-300'}`}>
                              {u.role}
                            </span>
                          </div>
                          <span className={`text-xs ${u.active === 'ACTIVE' ? 'text-green-400' : 'text-yellow-400'}`}>
                            {u.active === 'ACTIVE' ? '活跃' : '非活跃'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {usersData.pendingUsers?.length > 0 && (
                  <div>
                    <h4 className="text-slate-300 text-sm mb-2">待定邀请 ({usersData.pendingUsers.length})</h4>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {usersData.pendingUsers.map((u: any) => (
                        <div key={u.id} className="flex items-center justify-between bg-slate-950 rounded px-3 py-1.5 text-sm">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={selectedUserIds.has(String(u.id))} onChange={() => toggleUser(String(u.id))} />
                            <span className="text-yellow-300">{u.email}</span>
                          </div>
                          <span className="text-xs text-slate-400">等待中</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!usersData.users?.length && !usersData.pendingUsers?.length && (
                  <div className="text-slate-400 text-sm">暂无用户数据</div>
                )}
                <div className="flex items-center gap-3">
                  <button onClick={handleFetchUsers} disabled={loadingUsers}
                    className="text-sm text-indigo-400 hover:text-indigo-300">刷新列表</button>
                  <button onClick={() => setUsersData(null)}
                    className="text-sm text-slate-500 hover:text-slate-400">清空</button>
                </div>
              </div>
            )}
          </div>
        );
      }

      case 'bindCard':
        return (
          <div className="space-y-4">
            {proxySelector}
            <div>
              <label className="block text-slate-300 text-sm mb-1">广告号 ID (act_xxx 或纯数字)</label>
              <input value={adAccountId} onChange={e => setAdAccountId(e.target.value.replace(/^act_/, ''))}
                placeholder="123456789"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">卡号</label>
              <input value={ccNumber} onChange={e => setCcNumber(e.target.value)}
                placeholder="4111 1111 1111 1111"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none font-mono" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-300 text-sm mb-1">月份 (MM)</label>
                <input value={ccMonth} onChange={e => setCcMonth(e.target.value)}
                  placeholder="12"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-1">年份 (YYYY)</label>
                <input value={ccYear} onChange={e => setCcYear(e.target.value)}
                  placeholder="2027"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-1">CVC</label>
                <input value={ccCVC} onChange={e => setCcCVC(e.target.value)}
                  placeholder="123"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">国家 ISO 代码</label>
              <select value={ccIso} onChange={e => setCcIso(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none">
                <option value="US">United States</option>
                <option value="GB">United Kingdom</option>
                <option value="DE">Germany</option>
                <option value="FR">France</option>
                <option value="IT">Italy</option>
                <option value="ES">Spain</option>
                <option value="JP">Japan</option>
                <option value="KR">South Korea</option>
                <option value="SG">Singapore</option>
                <option value="AU">Australia</option>
                <option value="CA">Canada</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 text-sm mb-1">货币代码</label>
                <select value={bindCurrency} onChange={e => setBindCurrency(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none">
                  <option value="">不修改</option>
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="GBP">GBP (£)</option>
                  <option value="JPY">JPY (¥)</option>
                  <option value="KRW">KRW (₩)</option>
                  <option value="INR">INR (₹)</option>
                  <option value="THB">THB (฿)</option>
                  <option value="SGD">SGD (S$)</option>
                  <option value="VND">VND (₫)</option>
                  <option value="AUD">AUD (A$)</option>
                  <option value="CAD">CAD (C$)</option>
                  <option value="CNY">CNY (¥)</option>
                  <option value="TWD">TWD (NT$)</option>
                  <option value="MYR">MYR (RM)</option>
                  <option value="PHP">PHP (₱)</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-1">时区（FB 时区ID）</label>
                <select value={bindTimezone} onChange={e => setBindTimezone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none">
                  <option value="">不修改</option>
                  <option value="4">(GMT-08:00) Los Angeles</option>
                  <option value="4">(GMT-08:00) San Francisco</option>
                  <option value="4">(GMT-08:00) Vancouver</option>
                  <option value="5">(GMT-07:00) Denver</option>
                  <option value="5">(GMT-07:00) Phoenix</option>
                  <option value="6">(GMT-06:00) Chicago</option>
                  <option value="6">(GMT-06:00) Dallas</option>
                  <option value="6">(GMT-06:00) Mexico City</option>
                  <option value="7">(GMT-05:00) New York</option>
                  <option value="7">(GMT-05:00) Miami</option>
                  <option value="7">(GMT-05:00) Toronto</option>
                  <option value="8">(GMT-04:00) Halifax</option>
                  <option value="9">(GMT-03:00) Brasilia</option>
                  <option value="9">(GMT-03:00) Buenos Aires</option>
                  <option value="12">(GMT+00:00) London</option>
                  <option value="12">(GMT+00:00) Dublin</option>
                  <option value="12">(GMT+00:00) Lisbon</option>
                  <option value="13">(GMT+01:00) Berlin</option>
                  <option value="13">(GMT+01:00) Paris</option>
                  <option value="13">(GMT+01:00) Rome</option>
                  <option value="13">(GMT+01:00) Madrid</option>
                  <option value="14">(GMT+02:00) Helsinki</option>
                  <option value="14">(GMT+02:00) Kyiv</option>
                  <option value="14">(GMT+02:00) Athens</option>
                  <option value="15">(GMT+03:00) Moscow</option>
                  <option value="15">(GMT+03:00) Istanbul</option>
                  <option value="16">(GMT+04:00) Dubai</option>
                  <option value="16">(GMT+04:00) Abu Dhabi</option>
                  <option value="17">(GMT+05:00) Karachi</option>
                  <option value="17">(GMT+05:00) Islamabad</option>
                  <option value="18">(GMT+05:30) Mumbai</option>
                  <option value="18">(GMT+05:30) New Delhi</option>
                  <option value="18">(GMT+05:30) Kolkata</option>
                  <option value="18">(GMT+05:30) Chennai</option>
                  <option value="19">(GMT+06:00) Dhaka</option>
                  <option value="19">(GMT+06:00) Almaty</option>
                  <option value="20">(GMT+07:00) Bangkok</option>
                  <option value="20">(GMT+07:00) Jakarta</option>
                  <option value="20">(GMT+07:00) Hanoi</option>
                  <option value="21">(GMT+08:00) Beijing</option>
                  <option value="21">(GMT+08:00) Shanghai</option>
                  <option value="21">(GMT+08:00) Hong Kong</option>
                  <option value="21">(GMT+08:00) Singapore</option>
                  <option value="22">(GMT+09:00) Tokyo</option>
                  <option value="22">(GMT+09:00) Seoul</option>
                  <option value="23">(GMT+10:00) Sydney</option>
                  <option value="23">(GMT+10:00) Melbourne</option>
                  <option value="23">(GMT+10:00) Brisbane</option>
                  <option value="25">(GMT+12:00) Auckland</option>
                  <option value="25">(GMT+12:00) Wellington</option>
                  <option value="25">(GMT+12:00) Fiji</option>
                </select>
              </div>
            </div>
            <button onClick={handleBindCard} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              绑定卡片
            </button>
          </div>
        );

      case 'verifyBM':
        return (
          <div className="space-y-4">
            {proxySelector}
            <div className="bg-amber-900/20 border border-amber-700/40 rounded p-3 text-xs text-amber-200">
              <ShieldCheck className="w-4 h-4 inline mr-1" />
              手动触发 BM 业务认证（文件验证方式）。需确保浏览器已登录对应 BM 管理员账号，且 BM 未通过认证。
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 text-sm mb-1">Profile ID <span className="text-rose-400">*</span></label>
                <input value={verifyProfileId} onChange={e => setVerifyProfileId(e.target.value)}
                  placeholder="留空则使用列表第 1 项"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-1">BM ID <span className="text-rose-400">*</span></label>
                <input value={verifyBmId} onChange={e => setVerifyBmId(e.target.value)}
                  placeholder="留空则使用列表第 1 项"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">法律实体名称 <span className="text-rose-400">*</span></label>
              <input value={verifyLegalName} onChange={e => setVerifyLegalName(e.target.value)}
                placeholder="与营业执照完全一致的公司名称"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">法律实体地址</label>
              <input value={verifyLegalAddress} onChange={e => setVerifyLegalAddress(e.target.value)}
                placeholder="公司注册地址（与营业执照一致）"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 text-sm mb-1">电话</label>
                <input value={verifyPhone} onChange={e => setVerifyPhone(e.target.value)}
                  placeholder="+86 13800000000"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div>
                <label className="block text-slate-300 text-sm mb-1">网站</label>
                <input value={verifyWebsite} onChange={e => setVerifyWebsite(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">业务类型</label>
              <select value={verifyBusinessType} onChange={e => setVerifyBusinessType(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none">
                <option value="ADVERTISER">ADVERTISER（广告主，自己投放）</option>
                <option value="ADVERTISING_AGENCY">ADVERTISING_AGENCY（代理，为客户投放）</option>
                <option value="OTHER">OTHER（其他）</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">认证文件 <span className="text-rose-400">*</span></label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded cursor-pointer text-sm border border-slate-700">
                  <Upload className="w-4 h-4" /> 上传文件
                  <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp"
                    onChange={handleVerifyDocUpload} className="hidden" />
                </label>
                <span className="text-xs text-slate-400">支持 PDF / JPG / PNG 等，可多选</span>
              </div>
              {verifyDocs.length > 0 && (
                <div className="mt-2 space-y-1">
                  {verifyDocs.map((doc, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-950 rounded px-3 py-1.5 text-sm">
                      <div className="flex items-center gap-2 text-slate-200 truncate">
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        <span className="truncate">{doc.filename}</span>
                      </div>
                      <button onClick={() => removeVerifyDoc(idx)} className="text-rose-400 hover:text-rose-300 text-xs">移除</button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-400 mt-1">建议上传：营业执照、税务登记证、法人证件等（每个 BM 一份资料包）</p>
            </div>
            <button onClick={handleVerifyBM} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              提交 BM 认证
            </button>
          </div>
        );
      case 'sharePartner':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-slate-300 text-sm mb-1">合作伙伴 BM</label>
              <SearchSelect
                value={partnerBusinessId}
                onChange={setPartnerBusinessId}
                options={bmOptions}
                placeholder="-- 搜索并选择要分享到的 BM --"
                searchPlaceholder="输入 BM 名称或 BM ID 搜索"
                emptyText="没有取到系统 BM 列表（先去「BM 列表」页刷新一次）"
              />
              <p className="text-xs text-slate-500 mt-1">列表来自系统已有的 BM，支持按 BM 名称或 BM ID 搜索。也可以把要分享的 BM ID 直接贴进来。</p>
              <input value={partnerBusinessId} onChange={e => setPartnerBusinessId(e.target.value)}
                placeholder="或直接输入 BM ID"
                className="mt-1.5 w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded text-xs font-mono focus:ring-2 focus:ring-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">
                广告号 ID <span className="text-slate-500 font-normal">(留空则自动获取所选 BM 的全部活跃广告号)</span>
              </label>
              <textarea value={shareAdAccountIds} onChange={e => setShareAdAccountIds(e.target.value)}
                placeholder="可选: act_123, act_456 或纯数字，用逗号/空格/换行分隔"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none min-h-[60px] resize-none text-sm" />
            </div>
            <div>
              <label className="block text-slate-300 text-sm mb-1">权限</label>
              <div className="flex flex-wrap gap-3">
                {['MANAGE', 'ADVERTISE', 'ANALYZE'].map(task => (
                  <label key={task} className="inline-flex items-center gap-1.5 text-slate-300 text-sm">
                    <input type="checkbox" checked={partnerTasks.includes(task)}
                      onChange={e => setPartnerTasks(prev =>
                        e.target.checked ? [...prev, task] : prev.filter(t => t !== task)
                      )}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                    {task === 'MANAGE' ? '管理' : task === 'ADVERTISE' ? '广告' : '分析'}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-xs text-slate-400">
              此操作将把选中 BM 所拥有的活跃广告号以合作伙伴方式分享给目标 BM。
              如果手动指定了广告号 ID，则仅分享指定 ID。
            </p>
            <button onClick={handleSharePartner} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              分享到合作伙伴
            </button>
          </div>
        );
      case 'assignPersonalAd':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                FB 用户 ID <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={personalFbUserId}
                onChange={e => setPersonalFbUserId(e.target.value)}
                placeholder="对方个人 Facebook 用户 ID (数字)"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
              />
              <p className="text-xs text-slate-500 mt-1">
                授权对象必须是数字格式的 FB 用户 ID(不是邮箱),可通过 lookup-id 工具或对方主页 URL 获取。
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                广告号 ID (可选,留空自动拉取 BM 拥有的活跃广告号)
              </label>
              <input
                type="text"
                value={personalAdAccountIds}
                onChange={e => setPersonalAdAccountIds(e.target.value)}
                placeholder="act_xxx, act_yyy 或 xxx, yyy (多个用逗号分隔)"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-mono"
              />
            </div>
            <div className="p-3 bg-indigo-900/20 border border-indigo-800/50 rounded-lg">
              <p className="text-xs text-indigo-300">
                <Shield className="w-3.5 h-3.5 inline mr-1" />
                权限:固定全权限(ADMIN + GENERAL_USER)。对每个选中 BM 自动拉取 owned_ad_accounts 后授权。
              </p>
            </div>
            <button onClick={handleAssignPersonalAd} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
              广告号授权到个人号
            </button>
          </div>
        );
      case 'grantPersonalPage':
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                FB 用户 ID <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={personalFbUserId}
                onChange={e => setPersonalFbUserId(e.target.value)}
                placeholder="对方个人 Facebook 用户 ID (数字)"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
              />
              <p className="text-xs text-slate-500 mt-1">
                授权对象必须是数字格式的 FB 用户 ID(不是邮箱),可通过 lookup-id 工具或对方主页 URL 获取。
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                主页 ID (可选,留空自动拉取 BM 拥有的主页)
              </label>
              <input
                type="text"
                value={personalPageIds}
                onChange={e => setPersonalPageIds(e.target.value)}
                placeholder="page_id_1, page_id_2 (多个用逗号分隔)"
                className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-mono"
              />
            </div>
            <div className="p-3 bg-indigo-900/20 border border-indigo-800/50 rounded-lg">
              <p className="text-xs text-indigo-300">
                <Shield className="w-3.5 h-3.5 inline mr-1" />
                权限:固定全权限(MANAGE + CREATE_CONTENT + MODERATE + ADVERTISE + ANALYZE)。
              </p>
            </div>
            <button onClick={handleGrantPersonalPage} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
              主页授权到个人号
            </button>
          </div>
        );
      case 'refreshInfo':
        return (
          <div className="space-y-4">
            {proxySelector}
            <div className="bg-indigo-900/20 border border-indigo-800/50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <RefreshCw className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-indigo-300">刷新 BM 信息</h4>
                  <p className="text-xs text-indigo-400/80 mt-1">
                    从 Facebook Graph API 拉取选中 BM 的最新详细信息，包括名称、认证状态、拥有的广告号列表和主页列表。
                  </p>
                </div>
              </div>
            </div>
            <button onClick={handleRefreshInfo} disabled={processing}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              刷新 {items.length} 个 BM 信息
            </button>
          </div>
        );
      case 'syncPermissions':
        return (
          <div className="space-y-4">
            {proxySelector}
            <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <Shield className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-emerald-300">同步所有完整权限</h4>
                  <p className="text-xs text-emerald-400/80 mt-1">
                    将选中 BM 中拥有的所有广告号和主页，逐一授权给当前 BM 用户（即登录者），赋予完整权限（广告号: MANAGE+ADVERTISE+ANALYZE；主页: MANAGE+ADVERTISE+ANALYZE+CREATE_CONTENT+MESSAGING+MODERATE）。
                  </p>
                  <p className="text-xs text-amber-400/80 mt-1">
                    注意：如果 BM 用户不在 BM 组织中（无法获取 business_user_id），操作将跳过。
                  </p>
                </div>
              </div>
            </div>
            <button onClick={handleSyncPermissions} disabled={processing}
              className="w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50 flex items-center justify-center gap-2">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
              同步 {items.length} 个 BM 所有权限
            </button>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex justify-between items-center shrink-0">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-indigo-400" /> BM 管理操作
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {configureOnly
                ? `仅配置模式 · 将为 ${items.length} 个配置准备创建参数（点「保存配置」后由调用方执行）`
                : <>已选 {items.length} 个 BM {items[0] && `(例: ${items[0].bmId})`}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-2 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-3 border-b border-slate-800 overflow-x-auto shrink-0">
          {visibleTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setResults([]); setUsersData(null); setShareAdAccountIds(''); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-600/50'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-transparent'
              }`}
            >
              <tab.icon className="w-4 h-4" /> {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1">
          {renderForm()}

          {/* Results */}
          {results.length > 0 && (
            <div className="mt-4 space-y-1">
              <h4 className="text-sm font-medium text-slate-300 mb-2">操作结果:</h4>
              {results.map((r, idx) => (
                <div key={idx} className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded ${
                  r.status === 'success' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-rose-900/30 text-rose-300'
                }`}>
                  {r.status === 'success'
                    ? <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  }
                  <span className="font-mono text-xs">{r.bmId}:</span>
                  <span className="text-xs">{r.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
