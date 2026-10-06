/** 本地 API 服务器密钥，用于 PUP 服务器身份验证（构建时通过 VITE_LOCAL_SERVER_SECRET 注入） */
export const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

/** 获取本地 PUP 服务器地址（env 优先，fallback localhost:9999） */
export function getLaunchServerUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_LAUNCH_SERVER_URL;
  return (envUrl || 'http://localhost:9999').replace(/\/$/, '');
}

/** 获取存储后端地址（env 优先，fallback localhost:7000） */
export function getStorageServerUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL;
  return (envUrl || '').replace(/\/$/, '');
}

/**
 * 资产列表的行选择键 = `配置ID::资产ID`
 * 同一资产ID 在不同配置下会各占一行（云端表主键是 (id, profile_id)，主页/广告号/BM 都一样），
 * 只用资产ID 当选择键会有两个后果：
 *   ① 同ID 的多行被联动勾选；
 *   ② new Set(资产ID) 的长度永远小于行数 →「全选」的 size === length 判断永不成立，全选后无法取消。
 * 所以凡是用到「勾选集合」的地方（勾选/全选/批量操作/导出）都必须用这个键。
 */
export function selectionKeyOf(item: any, uniqueIdKey: string): string {
  if (!item) return '';
  const pid = item.profileId ?? item.profile_id ?? '';
  return `${String(pid)}::${String(item[uniqueIdKey] ?? '')}`;
}

/**
 * 主页「账号权限」缓存：配置ID -> { at, pages: { 主页ID -> 是否管理员 } }
 * 数据来源只有 me/accounts 的 tasks（「获取信息」/「获取主页」这两个动作本来就会调它），
 * 不再跟着列表刷新自动探测。主页列表（AssetViewer）和配置列表（ProfileManager）共用这一份。
 */
export const PAGE_RIGHTS_CACHE_KEY = 'cache:page-rights';

export type PageRightsEntry = { at: number; pages: Record<string, boolean> };
export type PageRightsCache = Record<string, PageRightsEntry>;

/** me/accounts 的 tasks → 这个账号在该主页上是不是管理员。
 *  新版主页给的是 PROFILE_PLUS_*（实测管理员是 PROFILE_PLUS_FULL_CONTROL + PROFILE_PLUS_MANAGE），
 *  老式主页给的是 MANAGE，都要认（与服务端 pages/manageable 的判定保持一致）。 */
export function canManageFromTasks(tasks: any): boolean {
  const t: string[] = Array.isArray(tasks) ? tasks : [];
  return t.includes('PROFILE_PLUS_FULL_CONTROL') || t.includes('PROFILE_PLUS_MANAGE') || t.includes('MANAGE');
}

export function readPageRightsCache(): PageRightsCache {
  try {
    const raw = localStorage.getItem(PAGE_RIGHTS_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj as PageRightsCache : {};
  } catch { return {}; }
}

/**
 * 统一的「BM 缓存行」：cache:businesses 里一行 = 一个配置下的一个 BM。
 *
 * ⚠️ 这份缓存历史上被三种写法污染过：
 *    ① {businessId}（获取信息 / 配置列表写的）
 *    ② {bmId}（BM 列表「整体刷新」直接把界面用的对象写回去）
 *    ③ 云端原始行（属主是蛇形 profile_id、BM 用 business_id / id）
 *    读取方各按不同的键取 → ② 那批读出来是空；而「按配置整体替换」又只认得 profileId，
 *    ③ 那批匹配不上 → 同一个 BM 在缓存里存两份，BM 列表先显示 2 行、刷新后才回到 1 行。
 *    这里统一成一个形状（关键字段补齐别名）并按 (配置ID, BM ID) 去重，先出现的优先。
 */
export function normBmRows(rows: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  (Array.isArray(rows) ? rows : []).forEach((b: any) => {
    if (!b || typeof b !== 'object') return;
    const profileId = String(b.profileId || b.profile_id || '');
    const businessId = String(b.businessId || b.business_id || b.bmId || b.id || '');
    if (!profileId || !businessId) return;
    const key = `${profileId}::${businessId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      profileId,
      businessId,
      // 别名补齐：不同读取方分别用 bmId / business_id / id 取
      bmId: businessId,
      business_id: businessId,
      id: businessId,
      profile_name: String(b.profileName || b.profile_name || ''),
      name: String(b.name || b.bmName || ''),
      verification_status: String(b.verification_status || b.verificationStatus || ''),
      admin_email: String(b.admin_email || b.adminEmail || ''),
      link: String(b.link || ''),
      updated_at: String(b.updated_at || ''),
      // 🕒 BM 创建时间（云端 fb_created_time / Graph creation_time）
      fbCreatedTime: String(b.fbCreatedTime || b.fb_created_time || b.creation_time || ''),
      // 🔢 可创建广告号上限（云端 ad_account_limit；内部 GraphQL ad_account_creation_limit）
      //    取不到时留空串而不是 0，列里才能显示「—」而不是「0」。
      adAccountLimit: (() => {
        const v = b.adAccountLimit ?? b.ad_account_limit;
        if (v === undefined || v === null || String(v).trim() === '') return '';
        const n = Number(v);
        return Number.isFinite(n) ? n : '';
      })(),
      // 🩺 账号质量（Account Quality 探测结果）：云端 businesses 表是 aq_status/aq_evidence/aq_policy
      //    蛇形三列，本地缓存是驼峰 aqStatus —— 两种都要认，否则每次归一化都会把它抹掉，白查一次。
      aqStatus: String(b.aqStatus || b.aq_status || ''),
      aqEvidence: String(b.aqEvidence || b.aq_evidence || ''),
      aqPolicy: String(b.aqPolicy || b.aq_policy || ''),
      // 👥 BM 成员（邮箱+角色）：云端是 bm_users JSON 字符串，本地缓存可能是数组 —— 统一成数组
      bmUsers: (() => {
        const raw = b.bmUsers ?? b.bm_users;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string' && raw.trim()) {
          try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
        }
        return [];
      })()
    });
  });
  return out;
}

/**
 * 把一次抓取结果里的主页列表（me/accounts，带 tasks）合并进权限缓存。
 * 只写 me/accounts 里出现过的主页：没出现的说明该账号在这主页上没有任何角色（列里显示「—」）。
 * @returns 合并后的整份缓存；本次没有可用数据时返回 null（调用方不必 setState）
 */
export function mergePageRightsCache(profileId: string, pages: any[]): PageRightsCache | null {
  const pid = String(profileId || '');
  if (!pid || !Array.isArray(pages) || pages.length === 0) return null;
  const map: Record<string, boolean> = {};
  pages.forEach((p: any) => {
    const id = String(p?.id || p?.pageId || p?.page_id || '');
    if (id) map[id] = canManageFromTasks(p?.tasks);
  });
  if (Object.keys(map).length === 0) return null;

  const cache = readPageRightsCache();
  cache[pid] = { at: Date.now(), pages: { ...(cache[pid]?.pages || {}), ...map } };
  try { localStorage.setItem(PAGE_RIGHTS_CACHE_KEY, JSON.stringify(cache)); } catch {}
  return cache;
}


/** Facebook 地区/语言选项 */
export const FB_LANGUAGES = [
  { code: 'zh_CN', name: '简体中文 (Chinese, Simplified)' },
  { code: 'zh_TW', name: '繁体中文 (Chinese, Traditional)' },
  { code: 'en_US', name: '英文 (English, US)' },
  { code: 'en_GB', name: '英文 (English, UK)' },
  { code: 'ja_JP', name: '日语 (Japanese)' },
  { code: 'ko_KR', name: '韩语 (Korean)' },
  { code: 'ru_RU', name: '俄语 (Russian)' },
  { code: 'de_DE', name: '德语 (German)' },
  { code: 'fr_FR', name: '法语 (French)' },
  { code: 'es_LA', name: '西班牙语 (Spanish, Latin America)' },
  { code: 'pt_BR', name: '葡萄牙语 (Portuguese, Brazil)' },
  { code: 'vi_VN', name: '越南语 (Vietnamese)' },
  { code: 'th_TH', name: '泰语 (Thai)' },
  { code: 'id_ID', name: '印尼语 (Indonesian)' },
  { code: 'ms_MY', name: '马来语 (Malay)' },
];

/** 常用货币列表 */
export const CURRENCIES = [
  'USD','EUR','GBP','JPY','CNY','AUD','CAD','BRL','INR','KRW','MXN','TWD','SGD',
  'HKD','NZD','CHF','SEK','NOK','DKK','PLN','TRY','ZAR','RUB','CLP','COP','PEN',
  'VND','NGN','EGP','PKR','BDT','LKR','KES','TZS','UGX','GHS','XAF','XOF','MAD',
  'DZD','IQD','JOD','OMR','QAR','SAR','AED','KWD','BHD',
];

/** 随机 BM 名称词库 */
export const RANDOM_BM_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Craft Studio', 'Wellness Center', 'Brew Lab', 'Pixel Perfect', 'Cloud Nine',
  'Sunset Media', 'Moonlight Studio', 'Star Tech', 'Ocean View', 'Mountain Peak',
  'Urban Nest', 'Cozy Corner', 'Bright Future', 'Blue Sky', 'Golden Gate',
  'Silver Lake', 'Iron Bridge', 'Maple Road', 'River Side', 'Forest Trail',
];

/** 时区选项 */
export const TZ_OPTIONS = [
  { label: '(UTC-11:00) 中途岛/萨摩亚', val: '1' },
  { label: '(UTC-10:00) 夏威夷', val: '2' },
  { label: '(UTC-09:00) 阿拉斯加', val: '3' },
  { label: '(UTC-08:00) 太平洋时间(美加)', val: '4' },
  { label: '(UTC-07:00) 山地时间(美加)', val: '5' },
  { label: '(UTC-07:00) 亚利桑那', val: '6' },
  { label: '(UTC-06:00) 中部时间(美加)', val: '7' },
  { label: '(UTC-06:00) 墨西哥城', val: '8' },
  { label: '(UTC-06:00) 萨斯喀彻温', val: '9' },
  { label: '(UTC-05:00) 东部时间(美加)', val: '10' },
  { label: '(UTC-05:00) 波哥大/利马/基多', val: '11' },
  { label: '(UTC-05:00) 印第安纳(东部)', val: '12' },
  { label: '(UTC-04:00) 大西洋时间(加拿大)', val: '13' },
  { label: '(UTC-04:00) 卡拉卡斯/拉巴斯', val: '14' },
  { label: '(UTC-04:00) 马瑙斯', val: '15' },
  { label: '(UTC-04:00) 圣地亚哥', val: '16' },
  { label: '(UTC-03:30) 纽芬兰', val: '17' },
  { label: '(UTC-03:00) 巴西利亚', val: '18' },
  { label: '(UTC-03:00) 布宜诺斯艾利斯/乔治敦', val: '19' },
  { label: '(UTC-03:00) 格陵兰', val: '20' },
  { label: '(UTC-03:00) 蒙得维的亚', val: '21' },
  { label: '(UTC-02:00) 中大西洋', val: '22' },
  { label: '(UTC-01:00) 亚速尔群岛', val: '23' },
  { label: '(UTC-01:00) 佛得角群岛', val: '24' },
  { label: '(UTC+00:00) 都柏林/伦敦/里斯本', val: '25' },
  { label: '(UTC+00:00) 卡萨布兰卡/蒙罗维亚', val: '26' },
  { label: '(UTC+01:00) 阿姆斯特丹/柏林/巴黎/罗马', val: '27' },
  { label: '(UTC+01:00) 贝尔格莱德/布拉迪斯拉发', val: '28' },
  { label: '(UTC+01:00) 布鲁塞尔/哥本哈根/马德里', val: '29' },
  { label: '(UTC+01:00) 萨拉热窝/斯科普里/华沙', val: '30' },
  { label: '(UTC+01:00) 金沙萨', val: '31' },
  { label: '(UTC+01:00) 斯德哥尔摩/布达佩斯', val: '32' },
  { label: '(UTC+01:00) 地拉那', val: '33' },
  { label: '(UTC+01:00) 维也纳/卢布尔雅那', val: '34' },
  { label: '(UTC+02:00) 基辅/赫尔辛基/里加/索非亚', val: '35' },
  { label: '(UTC+02:00) 雅典/伊斯坦布尔/明斯克', val: '36' },
  { label: '(UTC+02:00) 布加勒斯特', val: '37' },
  { label: '(UTC+02:00) 比勒陀利亚', val: '38' },
  { label: '(UTC+02:00) 哈拉雷', val: '39' },
  { label: '(UTC+02:00) 维尔纽斯/塔林', val: '40' },
  { label: '(UTC+02:00) 开罗', val: '41' },
  { label: '(UTC+02:00) 耶路撒冷', val: '42' },
  { label: '(UTC+02:00) 加布罗内', val: '43' },
  { label: '(UTC+02:00) 马普托', val: '44' },
  { label: '(UTC+02:00) 温得和克', val: '45' },
  { label: '(UTC+03:00) 巴格达', val: '46' },
  { label: '(UTC+03:00) 科威特/利雅得', val: '47' },
  { label: '(UTC+03:00) 莫斯科/圣彼得堡', val: '48' },
  { label: '(UTC+03:00) 内罗毕', val: '49' },
  { label: '(UTC+03:00) 第比利斯', val: '50' },
  { label: '(UTC+03:30) 德黑兰', val: '51' },
  { label: '(UTC+04:00) 阿布扎比/马斯喀特', val: '52' },
  { label: '(UTC+04:00) 巴库', val: '53' },
  { label: '(UTC+04:00) 埃里温', val: '54' },
  { label: '(UTC+04:00) 路易港', val: '55' },
  { label: '(UTC+04:30) 喀布尔', val: '56' },
  { label: '(UTC+05:00) 叶卡捷琳堡', val: '57' },
  { label: '(UTC+05:00) 伊斯兰堡/卡拉奇', val: '58' },
  { label: '(UTC+05:00) 塔什干', val: '59' },
  { label: '(UTC+05:30) 金奈/加尔各答/孟买/新德里', val: '60' },
  { label: '(UTC+05:30) 科伦坡', val: '61' },
  { label: '(UTC+05:45) 加德满都', val: '62' },
  { label: '(UTC+06:00) 阿拉木图', val: '63' },
  { label: '(UTC+06:00) 达卡', val: '64' },
  { label: '(UTC+06:00) 阿斯塔纳', val: '65' },
  { label: '(UTC+06:30) 仰光', val: '66' },
  { label: '(UTC+07:00) 曼谷/河内/雅加达', val: '67' },
  { label: '(UTC+07:00) 克拉斯诺亚尔斯克', val: '68' },
  { label: '(UTC+07:00) 新西伯利亚', val: '69' },
  { label: '(UTC+08:00) 北京/香港/新加坡/台北', val: '70' },
  { label: '(UTC+08:00) 伊尔库茨克/乌兰巴托', val: '71' },
  { label: '(UTC+08:00) 吉隆坡', val: '72' },
  { label: '(UTC+08:00) 珀斯', val: '73' },
  { label: '(UTC+09:00) 首尔', val: '74' },
  { label: '(UTC+09:00) 大阪/札幌/东京', val: '75' },
  { label: '(UTC+09:00) 雅库茨克', val: '76' },
  { label: '(UTC+09:30) 阿德莱德', val: '77' },
  { label: '(UTC+09:30) 达尔文', val: '78' },
  { label: '(UTC+10:00) 堪培拉/墨尔本/悉尼', val: '79' },
  { label: '(UTC+10:00) 布里斯班', val: '80' },
  { label: '(UTC+10:00) 霍巴特', val: '81' },
  { label: '(UTC+10:00) 符拉迪沃斯托克', val: '82' },
  { label: '(UTC+10:00) 关岛/莫尔兹比港', val: '83' },
  { label: '(UTC+10:00) 马加丹', val: '84' },
  { label: '(UTC+11:00) 所罗门群岛/新喀里多尼亚', val: '85' },
  { label: '(UTC+12:00) 奥克兰/惠灵顿', val: '86' },
  { label: '(UTC+12:00) 斐济/堪察加/马绍尔', val: '87' },
  { label: '(UTC+13:00) 努库阿洛法', val: '88' },
];
