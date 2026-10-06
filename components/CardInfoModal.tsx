import React, { useState } from 'react';
import { CreditCard, X, Calendar, Shield, MapPin, User } from 'lucide-react';

interface CardInfo {
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  holderName: string;
  country: string;
  billingStreet: string;
  billingCity: string;
  billingState: string;
  billingZip: string;
  currency: string;
  timezoneId: string;
  cardNetwork: string;
}

interface CardInfoModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (card: CardInfo) => void;
  profileCount: number;
}

const defaultCard: CardInfo = {
  number: '',
  expMonth: '',
  expYear: '',
  cvv: '',
  holderName: '',
  country: 'US',
  billingStreet: '',
  billingCity: '',
  billingState: '',
  billingZip: '',
  currency: 'USD',
  timezoneId: '1',
  cardNetwork: ''
};

export const CardInfoModal: React.FC<CardInfoModalProps> = ({ open, onClose, onConfirm, profileCount }) => {
  const [card, setCard] = useState<CardInfo>({ ...defaultCard });
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);

  if (!open) return null;

  const update = (k: keyof CardInfo, v: string) => setCard(prev => ({ ...prev, [k]: v }));

  const detectBrand = (n: string) => {
    const c = n.replace(/\D/g, '');
    if (/^4/.test(c)) return 'Visa';
    if (/^5[1-5]/.test(c)) return 'Mastercard';
    if (/^3[47]/.test(c)) return 'Amex';
    if (/^6/.test(c)) return 'Discover';
    return '';
  };

  const handleConfirm = () => {
    const withBrand = { ...card, cardNetwork: detectBrand(card.number) || card.cardNetwork };
    if (saveAsTemplate) {
      try { localStorage.setItem('card-template', JSON.stringify(withBrand)); } catch {}
    }
    onConfirm(withBrand);
  };

  const loadTemplate = () => {
    try {
      const raw = localStorage.getItem('card-template');
      if (raw) { const t = JSON.parse(raw); setCard({ ...defaultCard, ...t }); }
    } catch {}
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-slate-800 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-indigo-400" />
            <h3 className="text-lg font-bold text-white">绑卡信息</h3>
            <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2.5 py-0.5">批量 {profileCount} 个账户</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-slate-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* 快速模板加载 */}
          <button onClick={loadTemplate} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            从已保存模板加载
          </button>

          {/* 卡片主信息 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <CreditCard className="w-3.5 h-3.5" />卡号
              </label>
              <input
                type="text"
                value={card.number}
                onChange={e => update('number', e.target.value.replace(/\D/g, '').replace(/(\d{4})/g, '$1 ').trim())}
                placeholder="4242 4242 4242 4242"
                maxLength={19}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono tracking-wider"
              />
              {card.number && (
                <span className="text-[10px] text-indigo-400">{detectBrand(card.number) || '未知卡类型'}</span>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />到期月
              </label>
              <input
                type="text"
                value={card.expMonth}
                onChange={e => update('expMonth', e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="01"
                maxLength={2}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />到期年
              </label>
              <input
                type="text"
                value={card.expYear}
                onChange={e => update('expYear', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="2028"
                maxLength={4}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5" />CVV
              </label>
              <input
                type="text"
                value={card.cvv}
                onChange={e => update('cvv', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="123"
                maxLength={4}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />持卡人
              </label>
              <input
                type="text"
                value={card.holderName}
                onChange={e => update('holderName', e.target.value)}
                placeholder="John Doe"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
              />
            </div>
          </div>

          {/* 账单地址 */}
          <div>
            <h4 className="text-sm font-medium text-slate-300 mb-3 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5" />账单地址
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <label className="text-[10px] text-slate-500">街道地址</label>
                <input
                  type="text"
                  value={card.billingStreet}
                  onChange={e => update('billingStreet', e.target.value)}
                  placeholder="123 Main St"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">城市</label>
                <input
                  type="text"
                  value={card.billingCity}
                  onChange={e => update('billingCity', e.target.value)}
                  placeholder="New York"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">州/省</label>
                <input
                  type="text"
                  value={card.billingState}
                  onChange={e => update('billingState', e.target.value)}
                  placeholder="NY"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">邮编</label>
                <input
                  type="text"
                  value={card.billingZip}
                  onChange={e => update('billingZip', e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="10001"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">国家</label>
                <select value={card.country} onChange={e => update('country', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white">
                  <option value="US">美国</option>
                  <option value="GB">英国</option>
                  <option value="CA">加拿大</option>
                  <option value="AU">澳大利亚</option>
                  <option value="DE">德国</option>
                  <option value="FR">法国</option>
                  <option value="JP">日本</option>
                  <option value="SG">新加坡</option>
                  <option value="HK">香港</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">货币</label>
                <select value={card.currency} onChange={e => update('currency', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white">
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CAD">CAD</option>
                  <option value="AUD">AUD</option>
                  <option value="JPY">JPY</option>
                  <option value="SGD">SGD</option>
                  <option value="HKD">HKD</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-slate-500">时区偏移</label>
                <select value={card.timezoneId} onChange={e => update('timezoneId', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white">
                  <option value="1">UTC-8 (PST)</option>
                  <option value="2">UTC-7 (MST)</option>
                  <option value="3">UTC-6 (CST)</option>
                  <option value="4">UTC-5 (EST)</option>
                  <option value="5">UTC+0 (GMT)</option>
                  <option value="6">UTC+1 (CET)</option>
                  <option value="7">UTC+8 (Asia)</option>
                  <option value="8">UTC+9 (JST)</option>
                  <option value="9">UTC+10 (AEST)</option>
                </select>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <input type="checkbox" checked={saveAsTemplate} onChange={e => setSaveAsTemplate(e.target.checked)} className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
            保存为模板，下次自动加载
          </label>
        </div>

        <div className="p-6 border-t border-slate-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 bg-slate-800 text-slate-200 rounded-xl hover:bg-slate-700 transition-colors">取消</button>
          <button
            onClick={handleConfirm}
            disabled={!card.number || !card.expMonth || !card.expYear || !card.cvv}
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            开始绑卡 ({profileCount} 个)
          </button>
        </div>
      </div>
    </div>
  );
};
