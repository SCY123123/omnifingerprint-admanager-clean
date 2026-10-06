/**
 * 广告号字段组：「命名方式 + 时区/货币 + 账单信息」
 *
 * 为什么单独抽一个文件：「BM 操作弹窗」和「配置管理页的批量创建BM」是两个独立入口，
 * 以前各自维护一份字段，结果批量那边漏了时区 → 建出来的广告号时区变成默认值。
 * 现在两边共用这一份，字段与默认值天然同步。
 *
 * ⚠️ 名称与随机地址都不在前端生成：只把「方式 + 手填值 + 随机开关」交给后端，
 *    由后端在真正执行创建的那一刻取名/取值，否则同一批会拿到同一个时间戳、同一份地址。
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

// 🚀 时区选项 —— 与「批量操作 → 更改账单国家/时区/货币」对话框**完全同一份**（含 val 编号），
//    那边用的才是 Meta 正确的编号（如 Taipei=136、London=58、Los Angeles=1）。
export const TZ_OPTIONS = [
  { label: '(GMT-12:00) Baker Island', val: '3' },
  { label: '(GMT-11:00) Pago Pago', val: '3' },
  { label: '(GMT-10:00) Honolulu', val: '3' },
  { label: '(GMT-08:00) Anchorage', val: '4' },
  { label: '(GMT-07:00) Los Angeles', val: '1' },
  { label: '(GMT-06:00) Denver', val: '2' },
  { label: '(GMT-05:00) Chicago', val: '6' },
  { label: '(GMT-04:00) New York', val: '7' },
  { label: '(GMT-03:00) Halifax', val: '37' },
  { label: '(GMT-03:00) Brasilia', val: '25' },
  { label: '(GMT-02:00) Noronha', val: '22' },
  { label: '(GMT+00:00) Azores', val: '109' },
  { label: '(GMT+01:00) London', val: '58' },
  { label: '(GMT+02:00) Paris', val: '57' },
  { label: '(GMT+03:00) Athens', val: '60' },
  { label: '(GMT+03:00) Moscow', val: '116' },
  { label: '(GMT+04:00) Dubai', val: '8' },
  { label: '(GMT+05:00) Karachi', val: '105' },
  { label: '(GMT+05:30) New Delhi', val: '71' },
  { label: '(GMT+06:00) Dhaka', val: '17' },
  { label: '(GMT+07:00) Bangkok', val: '132' },
  { label: '(GMT+08:00) Taipei', val: '136' },
  { label: '(GMT+09:00) Tokyo', val: '77' },
  { label: '(GMT+10:00) Sydney', val: '15' },
  { label: '(GMT+11:00) Noumea', val: '24' },
  { label: '(GMT+12:00) Auckland', val: '100' },
];

// 🚀 账单国家（与 AssetViewer「更改账单国家/时区/货币」对话框一致）
export const BILL_COUNTRIES = [
  'US', 'GB', 'IE', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'SE', 'NO', 'DK', 'CH', 'PT', 'AT', 'FI', 'GR', 'PL',
  'CZ', 'HU', 'RO', 'BG', 'HR', 'AU', 'NZ', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'RU', 'UA', 'TR', 'SA',
  'AE', 'EG', 'CN', 'HK', 'MO', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH',
];
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];
export const AD_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'INR', 'THB', 'VND'];

const RANDOM_AD_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Future Vision', 'Ocean Breeze', 'Mountain Peak', 'Urban Style', 'Zen Master',
  'Bright Studio', 'Prime Media', 'Elite Commerce', 'Global Trade', 'Apex Digital',
  'Nova Solutions', 'Vertex Labs', 'Quantum Edge', 'Stellar Works', 'Crystal Bloom',
];

export type AdNameMode = 'manual' | 'random' | 'timestamp';

export interface AdAccountForm {
  nameMode: AdNameMode;
  manualName: string;      // nameMode=manual 时用的名称
  timezoneId: string;
  currency: string;
  billCountry: string;
  billCompany: string;
  billStreet: string;
  billCity: string;
  billState: string;
  billZip: string;
  billStreetRandom: boolean;
  billCityRandom: boolean;
  billStateRandom: boolean;
  billZipRandom: boolean;
}

export const genRandomAdName = () =>
  `${RANDOM_AD_NAMES[Math.floor(Math.random() * RANDOM_AD_NAMES.length)]} ${Math.floor(1000 + Math.random() * 9000)}`;

export const genTimestampAdName = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function defaultAdAccountForm(): AdAccountForm {
  return {
    nameMode: 'manual',
    manualName: '',
    timezoneId: '1',
    currency: 'USD',
    billCountry: 'US',
    billCompany: '',
    billStreet: '',
    billCity: '',
    billState: 'AL',
    billZip: '',
    billStreetRandom: false,
    billCityRandom: false,
    billStateRandom: false,
    billZipRandom: false,
  };
}

/** 广告号命名参数 → 后端（真正取名由后端在执行时做） */
export function adNamePayload(f: AdAccountForm) {
  return { adNameMode: f.nameMode, adNameManual: f.manualName.trim() };
}

/** 账单参数 → 后端（随机值也由后端在执行时生成） */
export function adBillingPayload(f: AdAccountForm) {
  return {
    country: f.billCountry.trim(),
    company: f.billCompany.trim(),
    street: f.billStreet.trim(),
    city: f.billCity.trim(),
    state: f.billState.trim(),
    zip: f.billZip.trim(),
    randomStreet: f.billStreetRandom,
    randomCity: f.billCityRandom,
    randomState: f.billStateRandom,
    randomZip: f.billZipRandom,
  };
}

interface Props {
  value: AdAccountForm;
  onChange: (patch: Partial<AdAccountForm>) => void;
  /** 手填名称输入框的占位文案（两个入口语义不同。默认给个通用文案） */
  manualPlaceholder?: string;
}

/** 广告号字段组（两个创建入口共用） */
export const AdAccountFields: React.FC<Props> = ({ value: f, onChange, manualPlaceholder }) => {
  // 随机/时间戳模式下的示例值，纯展示；真正提交的名称由后端在执行时生成
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (f.nameMode === 'random') setPreview(genRandomAdName());
    else if (f.nameMode === 'timestamp') setPreview(genTimestampAdName());
    else setPreview('');
  }, [f.nameMode]);

  const inputCls = 'w-full bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50';
  const randomBox = (checked: boolean, onToggle: (v: boolean) => void) => (
    <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onToggle(e.target.checked)}
        className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-indigo-600" />
      随机
    </label>
  );

  return (
    <div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-slate-400">广告号名称</label>
          <div className="flex items-center gap-2.5 text-xs text-slate-400">
            {([['manual', '手填'], ['random', '随机'], ['timestamp', '时间戳']] as const).map(([m, label]) => (
              <label key={m} className="flex items-center gap-1 cursor-pointer select-none">
                <input type="radio" name="adNameMode" checked={f.nameMode === m} onChange={() => onChange({ nameMode: m })}
                  className="w-3.5 h-3.5 border-slate-600 bg-slate-800 text-indigo-600" />
                {label}
              </label>
            ))}
          </div>
        </div>
        {f.nameMode === 'manual' ? (
          <input value={f.manualName} onChange={e => onChange({ manualName: e.target.value })}
            placeholder={manualPlaceholder || '输入广告号名称'}
            className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded focus:ring-2 focus:ring-indigo-500 outline-none" />
        ) : (
          <div className="flex gap-2">
            <input readOnly value={preview}
              className="flex-1 bg-slate-950 border border-slate-800 text-slate-400 px-3 py-2 rounded outline-none" />
            <button type="button"
              onClick={() => setPreview(f.nameMode === 'timestamp' ? genTimestampAdName() : genRandomAdName())}
              title="换一个"
              className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded text-sm shrink-0 flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> 换
            </button>
          </div>
        )}
        <p className="text-xs text-slate-500 mt-1">
          {f.nameMode === 'timestamp'
            ? `按本机时间命名：年月日时分秒（如 ${preview}），执行时取当下时间`
            : f.nameMode === 'random'
              ? '每个广告号使用不同随机名称（执行时生成）'
              : '创建多个时自动追加序号'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">时区</label>
          <select value={f.timezoneId} onChange={e => onChange({ timezoneId: e.target.value })} className={inputCls}>
            {TZ_OPTIONS.map(tz => <option key={tz.val} value={tz.val}>{tz.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">货币</label>
          <select value={f.currency} onChange={e => onChange({ currency: e.target.value })} className={inputCls}>
            {AD_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="text-xs text-slate-400">
        账单信息 <span className="text-slate-500">(广告号创建成功后由后端自动写入)</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">国家</label>
          <select value={f.billCountry} onChange={e => onChange({ billCountry: e.target.value })} className={inputCls}>
            {BILL_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] text-slate-500 mb-0.5">公司名称</label>
          <input value={f.billCompany} onChange={e => onChange({ billCompany: e.target.value })} placeholder="Example Inc."
            className={inputCls} />
        </div>
        <div className="col-span-3">
          <label className="block text-[10px] text-slate-500 mb-0.5">街道地址</label>
          <div className="flex gap-1">
            <input value={f.billStreet} onChange={e => onChange({ billStreet: e.target.value })} placeholder="123 Main St"
              disabled={f.billStreetRandom} className={`flex-1 ${inputCls}`} />
            {randomBox(f.billStreetRandom, v => onChange({ billStreetRandom: v, ...(v ? { billStreet: '' } : {}) }))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">城市</label>
          <div className="flex gap-1">
            <input value={f.billCity} onChange={e => onChange({ billCity: e.target.value })} placeholder="New York"
              disabled={f.billCityRandom} className={`flex-1 w-full min-w-0 ${inputCls}`} />
            {randomBox(f.billCityRandom, v => onChange({ billCityRandom: v, ...(v ? { billCity: '' } : {}) }))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">州 / 省</label>
          <div className="flex gap-1">
            <select value={f.billState} onChange={e => onChange({ billState: e.target.value })} disabled={f.billStateRandom}
              className={`flex-1 w-full min-w-0 ${inputCls}`}>
              {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {randomBox(f.billStateRandom, v => onChange({ billStateRandom: v, ...(v ? { billState: '' } : {}) }))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">邮编</label>
          <div className="flex gap-1">
            <input value={f.billZip} onChange={e => onChange({ billZip: e.target.value })} placeholder="10001"
              disabled={f.billZipRandom} className={`flex-1 w-full min-w-0 ${inputCls}`} />
            {randomBox(f.billZipRandom, v => onChange({ billZipRandom: v, ...(v ? { billZip: '' } : {}) }))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdAccountFields;
