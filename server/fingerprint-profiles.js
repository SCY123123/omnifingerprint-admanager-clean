// 🧬 每个 profile 一套「互相自洽」的设备画像（确定性生成）
//
// 为什么需要它：
//   以前所有配置共用同一套默认值 —— screen 固定 1920x1080、platform 固定 Win32、
//   WebGL 固定 "Intel Inc. / Intel Iris OpenGL Engine"（那是 Mac 的格式）、
//   插件固定 3 个、核数/内存固定 8/8。一百多个"不同的人"用同一台机器的画像，
//   很容易被聚类成同一批自动化；更糟的是 UA 写 Mac、platform 写 Win32 这种自相矛盾。
//
// 设计约束：
//   1. 确定性 —— 同一 profileId 永远得到完全相同的结果。
//      同一账号每次启动指纹都变，比指纹"不够真"更像自动化。
//   2. 自洽 —— 由 UA 决定 OS，OS 决定 platform / GPU / 分辨率池 / platformVersion，
//      分辨率决定 screen 与窗口，核数与内存档次匹配，互不打架。
//   3. 只补空 —— 用户已配置的字段一律尊重，不做覆盖。
'use strict';

// ---------- 确定性伪随机（mulberry32 + FNV-1a 播种） ----------
function seedOf(profileId) {
    const s = String(profileId == null ? '0' : profileId);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(a) {
    let t0 = a >>> 0;
    return function () {
        t0 = (t0 + 0x6D2B79F5) | 0;
        let t = Math.imul(t0 ^ (t0 >>> 15), 1 | t0);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(rnd, arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(rnd() * arr.length) % arr.length];
}

// ---------- 真实机型池（分辨率 / 核数 / 内存 / GPU 互相配套） ----------
// WebGL 的 UNMASKED_* 在真实 Chrome 上是 ANGLE 字符串，Windows 与 macOS 格式不同，
// 不能像以前那样两边共用一句 "Intel Iris OpenGL Engine"。
const WINDOWS_DEVICES = [
    {
        width: 1920, height: 1080, availHeight: 1040, cores: 8, memory: 8,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (NVIDIA)',
        gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    {
        width: 1366, height: 768, availHeight: 728, cores: 4, memory: 4,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (Intel)',
        gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    {
        width: 2560, height: 1440, availHeight: 1400, cores: 12, memory: 16,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (NVIDIA)',
        gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    {
        width: 1536, height: 864, availHeight: 824, cores: 8, memory: 8,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (AMD)',
        gpuRenderer: 'ANGLE (AMD, Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    {
        width: 1920, height: 1080, availHeight: 1040, cores: 16, memory: 16,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (NVIDIA)',
        gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    {
        width: 1280, height: 720, availHeight: 680, cores: 4, memory: 8,
        platformVersion: '10.0.0',
        gpuVendor: 'Google Inc. (Intel)',
        gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    }
];

const MAC_DEVICES = [
    {
        width: 1440, height: 900, availHeight: 875, cores: 8, memory: 8,
        platformVersion: '13.6.0', architecture: 'arm',
        gpuVendor: 'Google Inc. (Apple)',
        gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'
    },
    {
        width: 1512, height: 982, availHeight: 957, cores: 10, memory: 16,
        platformVersion: '14.5.0', architecture: 'arm',
        gpuVendor: 'Google Inc. (Apple)',
        gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)'
    },
    {
        width: 1728, height: 1117, availHeight: 1092, cores: 8, memory: 16,
        platformVersion: '13.6.0', architecture: 'arm',
        gpuVendor: 'Google Inc. (Apple)',
        gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'
    },
    {
        width: 2560, height: 1600, availHeight: 1575, cores: 12, memory: 32,
        platformVersion: '14.5.0', architecture: 'arm',
        gpuVendor: 'Google Inc. (Apple)',
        gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)'
    }
];

const DEFAULT_CHROME_MAJOR = '131';

// ---------- UA 解析 ----------
function parseUA(ua) {
    const s = String(ua || '');
    const mac = /Macintosh|Mac OS X/i.test(s);
    const win = /Windows/i.test(s);
    const linux = /Linux/i.test(s) && !/Android/i.test(s);
    const chromeMatch = s.match(/Chrome\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
    const edgeMajor = (s.match(/Edg\/(\d+)/) || [])[1] || '';
    const operaMajor = (s.match(/OPR\/(\d+)/) || [])[1] || '';
    let os = 'windows';
    if (mac) os = 'macos';
    else if (win) os = 'windows';
    else if (linux) os = 'linux';
    // 浏览器品牌：决定 UA-CH 里 brands 的结构，也决定「能不能安全地对齐 Chrome 内核版本」
    // （Edge/Opera 的 UA 里 Chrome 版本与 Edg/OPR 版本必须配套，乱改 Chrome 版本会自相矛盾）
    let browser = 'chrome';
    if (edgeMajor) browser = 'edge';
    else if (operaMajor) browser = 'opera';
    return {
        os,
        browser,
        platform: os === 'macos' ? 'MacIntel' : 'Win32',
        chromeMajor: chromeMatch ? chromeMatch[1] : '',
        chromeFull: chromeMatch ? [
            chromeMatch[1] || '0',
            chromeMatch[2] || '0',
            chromeMatch[3] || '0',
            chromeMatch[4] || '0'
        ].join('.') : '',
        hasUA: s.trim().length > 0
    };
}

function buildDefaultUA(os, chromeMajor) {
    const major = chromeMajor || DEFAULT_CHROME_MAJOR;
    if (os === 'macos') {
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    }
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// ---------- 语言 ----------
function normalizeLanguage(rawLanguage, fbLanguage) {
    let lang = String(rawLanguage || '').trim();
    if (!lang) {
        const fb = String(fbLanguage || '').trim();
        if (fb) lang = fb.replace(/_/g, '-');
    }
    if (!lang) lang = 'en-US';
    if (!lang.includes('-')) {
        const base = lang.toLowerCase();
        if (base === 'zh') lang = 'zh-CN';
        else if (base === 'en') lang = 'en-US';
        else if (base === 'ja') lang = 'ja-JP';
        else lang = base + '-' + base.toUpperCase();
    }
    return lang;
}

function buildLanguageChain(lang) {
    const base = String(lang).split('-')[0];
    const list = [lang, base, 'en'];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

function buildAcceptLanguage(lang) {
    const base = String(lang).split('-')[0];
    return base && base !== lang ? `${lang},${base};q=0.9` : `${lang}`;
}

// ---------- 主函数 ----------
/**
 * 生成 / 补全一个 profile 的自洽画像。
 * @param {string|number} profileId
 * @param {object} profile 现有配置（os/resolution/timezone/language/fbLanguage/userAgent/fingerprintProtection…）
 * @returns {object} 画像（含 changed 标记，便于调用方决定是否回写）
 */
function normalizeProfileFingerprint(profileId, profile) {
    const p = profile || {};
    const fpRaw = (p.fingerprintProtection && typeof p.fingerprintProtection === 'object') ? p.fingerprintProtection : {};
    const rnd = mulberry32(seedOf(profileId));
    const changed = [];

    // 1) UA → OS（UA 优先：UA 决定 UA-CH 与 platform，必须与它对齐）
    const ua = String(p.userAgent || '').trim();
    const parsed = parseUA(ua);
    let os = parsed.os;
    const configuredOs = String(p.os || '').trim().toLowerCase();
    if (!ua && configuredOs && configuredOs !== 'random') {
        os = configuredOs === 'macos' || configuredOs === 'mac' ? 'macos' : 'windows';
    }
    if (os === 'linux') os = 'windows'; // 池子里没有 Linux 机型，降级到 Windows 避免半真半假

    // 2) 机型（分辨率 / 核数 / 内存 / GPU）
    const pool = os === 'macos' ? MAC_DEVICES : WINDOWS_DEVICES;
    const device = pick(rnd, pool) || pool[0];

    // 3) 分辨率：尊重配置，否则用机型
    let width = device.width;
    let height = device.height;
    const configuredRes = String(p.resolution || '').trim();
    if (configuredRes) {
        const parts = configuredRes.split(/[x×X,，]/).map(n => parseInt(n, 10));
        if (parts.length >= 2 && parts[0] > 0 && parts[1] > 0) {
            width = parts[0];
            height = parts[1];
        }
    }

    // 4) platform
    const platform = os === 'macos' ? 'MacIntel' : 'Win32';

    // 5) UA：配置优先；没有就按 OS 生成
    const chromeMajor = parsed.chromeMajor || DEFAULT_CHROME_MAJOR;
    const userAgent = ua || buildDefaultUA(os, chromeMajor);
    if (!ua) changed.push('userAgent');

    // 6) 语言
    const lang = normalizeLanguage(p.language, p.fbLanguage);
    if (!String(p.language || '').trim()) changed.push('language');
    const languages = buildLanguageChain(lang);
    const acceptLanguage = buildAcceptLanguage(lang);

    // 7) 时区：只认显式配置（运行时若为空会尝试按代理出口探测）
    const timezone = String(p.timezone || '').trim();

    // 8) GPU / 核数 / 内存 / 插件：配置优先，否则取机型
    const gpuVendor = String(fpRaw.webglVendor || '').trim() || device.gpuVendor;
    const gpuRenderer = String(fpRaw.webglRenderer || '').trim() || device.gpuRenderer;
    const cpuCores = Number(fpRaw.cpuCores) > 0 ? Number(fpRaw.cpuCores) : device.cores;
    const deviceMemory = Number(fpRaw.deviceMemory) > 0 ? Number(fpRaw.deviceMemory) : device.memory;
    const pluginsCount = Number(fpRaw.pluginsCount) > 0 ? Number(fpRaw.pluginsCount) : 5;

    return {
        os,
        browser: parsed.browser,
        platform,
        width,
        height,
        availHeight: Math.max(height - 40, device.availHeight),
        colorDepth: 24,
        cpuCores,
        deviceMemory,
        gpuVendor,
        gpuRenderer,
        pluginsCount,
        userAgent,
        chromeMajor,
        chromeFull: parsed.chromeFull || `${chromeMajor}.0.0.0`,
        platformVersion: device.platformVersion,
        architecture: device.architecture || 'x86',
        timezone,
        language: lang,
        languages,
        acceptLanguage,
        // 🎨 各随机化开关的最终取值（'random' 才注入，'off' / 空 都不注入）
        canvas: String(p.fpCanvas || fpRaw.canvas || '').trim(),
        webgl: String(p.fpWebgl || fpRaw.webgl || '').trim(),
        audio: String(p.fpAudio || fpRaw.audio || '').trim(),
        changed
    };
}

// ---------- UA-CH（Sec-CH-UA / navigator.userAgentData） ----------
// 只改 --user-agent 字符串的话，Sec-CH-UA 仍是真实 Chrome 版本，两边对不上 —— 这是
// 很典型的"UA 被改过"的特征。这里按 UA 里声明的版本构造一致的 metadata。
function buildUserAgentMetadata(fp) {
    const major = String((fp && fp.chromeMajor) || DEFAULT_CHROME_MAJOR);
    const full = String((fp && fp.chromeFull) || `${major}.0.0.0`);
    const platformName = (fp && fp.os) === 'macos' ? 'macOS' : 'Windows';
    const browser = String((fp && fp.browser) || 'chrome');
    // brands 必须与 UA 里的浏览器品牌一致：UA 写 Edge 而 brands 只有 Google Chrome 是硬伤
    let brands;
    if (browser === 'edge') {
        brands = [
            { brand: 'Microsoft Edge', version: major },
            { brand: 'Chromium', version: major },
            { brand: 'Not)A;Brand', version: '24' }
        ];
    } else if (browser === 'opera') {
        brands = [
            { brand: 'Opera', version: major },
            { brand: 'Chromium', version: major },
            { brand: 'Not)A;Brand', version: '24' }
        ];
    } else {
        brands = [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not?A_Brand', version: '24' }
        ];
    }
    return {
        brands,
        fullVersion: full,
        platform: platformName,
        platformVersion: String((fp && fp.platformVersion) || '10.0.0'),
        architecture: String((fp && fp.architecture) || 'x86'),
        model: '',
        mobile: false
    };
}

module.exports = {
    normalizeProfileFingerprint,
    buildUserAgentMetadata,
    parseUA,
    seedOf
};
