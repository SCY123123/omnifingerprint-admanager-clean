import React, { useState } from 'react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl } from '../utils/constants';
import type { AdAccountRow } from '../types';

interface CcyTzDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTarget: AdAccountRow | null;
  targets: AdAccountRow[];
  tzOptions: { label: string; val: string }[];
  loading: boolean;
  onRefresh: () => void;
  setLoading: (v: boolean) => void;
}

export const CcyTzDialog: React.FC<CcyTzDialogProps> = ({
  isOpen, onClose, initialTarget, targets, tzOptions, loading, onRefresh, setLoading
}) => {
  const [currency, setCurrency] = useState('USD');
  const [timezone, setTimezone] = useState('1');
  const [lang, setLang] = useState('');
  const [businessName, setBusinessName] = useState('');

  const handleUpdate = async () => {
    const aa = targets[0] || initialTarget;
    if (!aa) { alert('请先选择广告账户'); return; }
    const lurl = getLaunchServerUrl();
    try {
      setLoading(true);
      const resp = await fetch(`${lurl}/api/facebook/adaccounts/change-currency-timezone`, {
        method:'POST', headers:{'Content-Type':'application/json','X-Api-Secret':LOCAL_SERVER_SECRET},
        body: JSON.stringify({
          profileId: String(aa.profileId),
          adAccountId: String(aa.adAccountId || aa.account_id || aa.id),
          currency,
          timezone_id: timezone,
          lang: lang || undefined,
          business_name: businessName || undefined
        })
      });
      const json = await resp.json();
      if (json.success) {
        alert('货币/时区已更新（本地）');
        onClose();
        onRefresh();
      } else {
        alert(`更新失败: ${json.message || '未知错误'}`);
      }
    } catch (e) { alert(`请求失败: ${(e as Error).message}`); }
    finally { setLoading(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">更改账单国家/时区/货币</h3>
        <p className="text-xs text-slate-400 mb-3">注：Facebook 不支持 API 修改已创建账户的货币/时区，通过智能策略页面修改</p>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">货币</label>
            <select value={currency} onChange={e => setCurrency(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
              {['USD','EUR','GBP','JPY','CNY','AUD','CAD','BRL','INR','KRW','MXN','TWD','SGD','HKD','NZD','CHF','SEK','NOK','DKK','PLN','TRY','ZAR','RUB','CLP','COP','PEN','VND','NGN','EGP','PKR','BDT','LKR','KES','TZS','UGX','GHS','XAF','XOF','MAD','DZD','IQD','JOD','OMR','QAR','SAR','AED','KWD','BHD'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">时区（选择城市）</label>
            <select value={timezone || '1'} onChange={e => setTimezone(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm">
              <option value="">请选择时区</option>
              {tzOptions.map(tz => <option key={tz.label} value={tz.val}>{tz.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">FB界面语言</label>
            <select value={lang} onChange={e => setLang(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded">
              <option value="">不修改</option>
              <option value="en_US">🇺🇸 English (US)</option>
              <option value="zh_CN">🇨🇳 简体中文</option>
              <option value="es_ES">🇪🇸 Español (ES)</option>
              <option value="fr_FR">🇫🇷 Français (FR)</option>
              <option value="pt_BR">🇧🇷 Português (BR)</option>
              <option value="de_DE">🇩🇪 Deutsch (DE)</option>
              <option value="it_IT">🇮🇹 Italiano (IT)</option>
              <option value="ja_JP">🇯🇵 日本語</option>
              <option value="ko_KR">🇰🇷 한국어</option>
              <option value="th_TH">🇹🇭 ภาษาไทย</option>
              <option value="vi_VN">🇻🇳 Tiếng Việt</option>
              <option value="id_ID">🇮🇩 Bahasa Indonesia</option>
              <option value="ms_MY">🇲🇾 Bahasa Melayu</option>
              <option value="ar_AR">🇸🇦 العربية</option>
              <option value="tr_TR">🇹🇷 Türkçe</option>
              <option value="ru_RU">🇷🇺 Русский</option>
              <option value="pl_PL">🇵🇱 Polski</option>
              <option value="nl_NL">🇳🇱 Nederlands</option>
            </select>
          </div>
          <button onClick={handleUpdate} disabled={loading} className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm">确认更新</button>
        </div>
      </div>
    </div>
  );
};
