import React, { useState, useEffect } from 'react';
import { X, RefreshCw, Upload, Globe, Image as ImageIcon, CheckCircle2, AlertCircle, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PageCreatorProps {
  onCancel: () => void;
  onConfirm: (data: PageCreationData) => void;
  profileIds: string[];
  initialData?: PageCreationData; // 编辑回填用
}

export interface PageCreationData {
  name: string;
  isRandomName: boolean;
  isRandomCategory?: boolean;
  isRandomWebsite?: boolean;
  profileImage?: File;
  backgroundImage?: File;
  website: string;
  category: string;
  useSession?: boolean; // session创建开关 → true: API快速创建, false: 浏览器手动创建
  proxyId?: string;
  proxyManualInput?: string;
  proxyType?: string;
  proxyOverride?: any;
}

const CATEGORIES = [
  { en: 'Digital Creator', zh: '数字创作者' },
  { en: 'Business Service', zh: '商业服务' },
  { en: 'Entertainment Website', zh: '娱乐网站' },
  { en: 'Health/Beauty', zh: '健康/美容' },
  { en: 'Product/Service', zh: '产品/服务' },
  { en: 'Shopping & Retail', zh: '购物与零售' },
  { en: 'Artist/Band', zh: '艺术家/乐队' },
  { en: 'Brand/Product', zh: '品牌/产品' },
  { en: 'Cause/Community', zh: '公益/社区' },
  { en: 'Education', zh: '教育' },
  { en: 'Entrepreneur', zh: '创业者' },
  { en: 'Fashion/Model', zh: '时尚/模特' },
  { en: 'Food/Beverage', zh: '食品/饮料' },
  { en: 'Government Official', zh: '政府官员' },
  { en: 'Journalist', zh: '记者' },
  { en: 'Local Business', zh: '本地商家' },
  { en: 'Media/News Company', zh: '媒体/新闻' },
  { en: 'Movie/TV Show', zh: '电影/电视节目' },
  { en: 'Musician/Band', zh: '音乐人/乐队' },
  { en: 'Non-Profit Organization', zh: '非营利组织' },
  { en: 'Personal Blog', zh: '个人博客' },
  { en: 'Photographer', zh: '摄影师' },
  { en: 'Politician', zh: '政治人物' },
  { en: 'Public Figure', zh: '公众人物' },
  { en: 'Real Estate', zh: '房地产' },
  { en: 'Restaurant/Cafe', zh: '餐厅/咖啡馆' },
  { en: 'School', zh: '学校' },
  { en: 'Software/App', zh: '软件/应用' },
  { en: 'Sports Team/Sportsperson', zh: '运动队/运动员' },
  { en: 'Tutor/Teacher', zh: '家教/教师' },
  { en: 'Travel/Tourism', zh: '旅游/观光' },
  { en: 'Video Creator', zh: '视频创作者' },
  { en: 'Website/Blog', zh: '网站/博客' },
  { en: 'Writer', zh: '作家' },
];

const RANDOM_NAMES = [
  'Eco Life', 'Tech Trends', 'Daily Joy', 'Green Garden', 'Smart Home',
  'Fashion Hub', 'Pet Paradise', 'Foodie Adventure', 'Fitness First', 'Travel Guide',
  'Artistic Soul', 'Music Magic', 'Gaming World', 'Movie Night', 'Book Worm',
  'Future Vision', 'Ocean Breeze', 'Mountain Peak', 'Urban Style', 'Zen Master'
];

export const PageCreator: React.FC<PageCreatorProps> = ({ onCancel, onConfirm, profileIds, initialData }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(initialData?.name || '');
  const [isRandomName, setIsRandomName] = useState(initialData?.isRandomName ?? false);
  const [isRandomCategory, setIsRandomCategory] = useState(initialData?.isRandomCategory ?? false);
  const [isRandomWebsite, setIsRandomWebsite] = useState(initialData?.isRandomWebsite ?? false);
  const [website, setWebsite] = useState(initialData?.website || '');
  const [category, setCategory] = useState(initialData?.category || CATEGORIES[0].en);
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<File | null>(null);
  const [useSession, setUseSession] = useState(initialData?.useSession ?? false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [proxyList, setProxyList] = useState<Array<any>>([]);
  const [selectedProxyId, setSelectedProxyId] = useState(initialData?.proxyId || '');
  const [proxyManualInput, setProxyManualInput] = useState(initialData?.proxyManualInput || '');
  const [proxyType, setProxyType] = useState(initialData?.proxyType || 'http'); // 手动选择代理类型

  // 🚀 加载代理管理列表
  useEffect(() => {
    (async () => {
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        const r = await fetch(`${base}/api/proxies`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const j = await r.json();
        const list = Array.isArray(j?.data) ? j.data : [];
        setProxyList(list);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (isRandomName) {
      generateRandomName();
    }
  }, [isRandomName]);

  useEffect(() => {
    if (isRandomCategory) {
      const randomCat = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      setCategory(randomCat.en);
    }
  }, [isRandomCategory]);

  useEffect(() => {
    if (isRandomWebsite && name.trim()) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-page';
      setWebsite(`https://${slug}.com`);
    }
  }, [isRandomWebsite]);

  useEffect(() => {
    if (isRandomWebsite && isRandomName && name.trim()) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-page';
      setWebsite(`https://${slug}.com`);
    }
  }, [name]);

  const generateRandomName = () => {
    const randomName = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
    const suffix = Math.floor(1000 + Math.random() * 9000);
    setName(`${randomName} ${suffix}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const payload = {
        name, isRandomName, isRandomCategory, isRandomWebsite, website, category, useSession,
        proxyId: selectedProxyId || undefined,
        proxyManualInput: proxyManualInput || undefined,
        proxyType: proxyType || undefined
      };
      // 保存到数据库（静默，不影响流程）
      try {
        const serverUrl = (import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/';
        const base = String(serverUrl || '').replace(/\/$/, '');
        const authToken = localStorage.getItem('auth_token');
        fetch(`${base}/api/publish-configs/page`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ value: payload })
        }).catch(() => {});
      } catch {}
      await onConfirm({
        name, isRandomName, isRandomCategory, isRandomWebsite,
        profileImage: profileImage || undefined,
        backgroundImage: backgroundImage || undefined,
        website, category, useSession,
        proxyId: selectedProxyId || undefined,
        proxyManualInput: proxyManualInput || undefined,
        proxyType: proxyType || undefined
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
        <div className="flex justify-between items-center p-6 border-b border-slate-800 bg-slate-900/50">
          <div>
            <h2 className="text-xl font-bold text-white">创建主页</h2>
            <p className="text-slate-400 text-sm mt-1">为选中的 {profileIds.length} 个配置创建 Facebook 公共主页</p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* 创建模式选择 */}
          <div className="flex items-center justify-between gap-3 p-3 bg-indigo-600/10 border border-indigo-600/20 rounded-xl">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useSession}
                onChange={(e) => setUseSession(e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500/50"
              />
              <span className="text-sm font-medium text-slate-200">Session API创建 (速度快)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!useSession}
                onChange={(e) => setUseSession(!e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-amber-500 focus:ring-amber-500/50"
              />
              <span className="text-sm text-amber-300">手动创建 (浏览器操作)</span>
            </label>
          </div>

          {/* Name Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-slate-300">主页名称</label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isRandomName}
                  onChange={(e) => {
                    setIsRandomName(e.target.checked);
                    if (e.target.checked) generateRandomName();
                  }}
                  className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600"
                />
                <RefreshCw className={`w-3 h-3 ${isRandomName ? 'text-indigo-400' : 'text-slate-500'}`} />
                随机生成
              </label>
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (isRandomName) setIsRandomName(false);
              }}
              placeholder="输入主页名称"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
              required
            />
          </div>

          {/* Category Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-slate-300">类别</label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                <input type="checkbox" checked={isRandomCategory} onChange={e => { setIsRandomCategory(e.target.checked); if (e.target.checked) { const rc = CATEGORIES[Math.floor(Math.random()*CATEGORIES.length)]; setCategory(rc.en); } }} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                <RefreshCw className={`w-3 h-3 ${isRandomCategory ? 'text-indigo-400' : 'text-slate-500'}`} />
                随机
              </label>
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isRandomCategory}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all appearance-none disabled:opacity-60"
            >
              {CATEGORIES.map(cat => (
                <option key={cat.en} value={cat.en}>{cat.zh} ({cat.en})</option>
              ))}
            </select>
          </div>

          {/* Website Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-slate-300">主页域名/网站</label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
                <input type="checkbox" checked={isRandomWebsite} onChange={e => { setIsRandomWebsite(e.target.checked); if (e.target.checked && name.trim()) { const s = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'my-page'; setWebsite(`https://${s}.com`); } }} className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-indigo-600" />
                <RefreshCw className={`w-3 h-3 ${isRandomWebsite ? 'text-indigo-400' : 'text-slate-500'}`} />
                随机
              </label>
            </div>
            <div className="relative">
              <Globe className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="url"
                value={website}
                onChange={(e) => { setWebsite(e.target.value); if (isRandomWebsite) setIsRandomWebsite(false); }}
                placeholder="https://example.com"
                disabled={isRandomWebsite}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-11 pr-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all disabled:opacity-60"
              />
            </div>
          </div>

          {/* Proxy Selection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-slate-400" />
              <label className="text-sm font-medium text-slate-300">代理覆盖 (可输入或下拉选择)</label>
              {selectedProxyId && <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">已选库</span>}
              {proxyManualInput && !selectedProxyId && <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">手动输入</span>}
            </div>
            <div className="flex gap-2">
              <select
                value={proxyType}
                onChange={(e) => setProxyType(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-white text-sm shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              >
                <option value="http">http</option>
                <option value="socks5">socks5</option>
                <option value="https">https</option>
              </select>
              <input
                list="pageProxyList"
                value={proxyManualInput}
                onChange={(e) => { setProxyManualInput(e.target.value); setSelectedProxyId(''); }}
                placeholder="host:port 或 user:pass@host:port"
                className="flex-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
              />
              <datalist id="pageProxyList">
                {proxyList.map(px => (
                  <option key={px.id} value={`${px.host}:${px.port}`} label={`${px.label ? px.label+' | ' : ''}${px.host}:${px.port}${px.channel ? ' ['+px.channel+']' : ''}${px.category ? ' - '+px.category : ''}`}>
                    {`${px.label ? px.label+' | ' : ''}${px.host}:${px.port}${px.channel ? ' ['+px.channel+']' : ''}${px.category ? ' - '+px.category : ''}`}
                  </option>
                ))}
              </datalist>
              {(proxyManualInput || selectedProxyId) && (
                <button type="button" onClick={() => { setProxyManualInput(''); setSelectedProxyId(''); }}
                  className="px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl shrink-0">
                  清除
                </button>
              )}
            </div>
          </div>

          {/* Upload Section */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300 text-center block">头像上传</label>
              <label className="flex flex-col items-center justify-center h-24 bg-slate-950 border-2 border-dashed border-slate-800 rounded-xl cursor-pointer hover:border-indigo-500/50 transition-all group overflow-hidden relative">
                {profileImage ? (
                  <>
                    <img src={URL.createObjectURL(profileImage)} className="absolute inset-0 w-full h-full object-cover opacity-40" alt="profile" />
                    <CheckCircle2 className="w-6 h-6 text-emerald-500 relative z-10" />
                    <span className="text-[10px] text-slate-300 relative z-10 mt-1 truncate max-w-[80%]">{profileImage.name}</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-slate-500 group-hover:text-indigo-400 transition-colors" />
                    <span className="text-[10px] text-slate-500 mt-2">点击上传</span>
                  </>
                )}
                <input type="file" accept="image/*" onChange={(e) => setProfileImage(e.target.files?.[0] || null)} className="hidden" />
              </label>
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300 text-center block">背景图上传</label>
              <label className="flex flex-col items-center justify-center h-24 bg-slate-950 border-2 border-dashed border-slate-800 rounded-xl cursor-pointer hover:border-indigo-500/50 transition-all group overflow-hidden relative">
                {backgroundImage ? (
                  <>
                    <img src={URL.createObjectURL(backgroundImage)} className="absolute inset-0 w-full h-full object-cover opacity-40" alt="background" />
                    <CheckCircle2 className="w-6 h-6 text-emerald-500 relative z-10" />
                    <span className="text-[10px] text-slate-300 relative z-10 mt-1 truncate max-w-[80%]">{backgroundImage.name}</span>
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-6 h-6 text-slate-500 group-hover:text-indigo-400 transition-colors" />
                    <span className="text-[10px] text-slate-500 mt-2">点击上传</span>
                  </>
                )}
                <input type="file" accept="image/*" onChange={(e) => setBackgroundImage(e.target.files?.[0] || null)} className="hidden" />
              </label>
            </div>
          </div>

          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 px-4 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-all"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="flex-1 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-bold transition-all shadow-lg shadow-indigo-600/20"
            >
              {isSubmitting ? '正在启动...' : '开始创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
