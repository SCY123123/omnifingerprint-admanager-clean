import React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from '../types';
import { Play, Square, Key, LogIn, Pencil, ShieldCheck, RefreshCw, Download, FileText, Briefcase, CreditCard, Upload, Share2, Globe, UserPlus, Trash2, PlusCircle, ChevronDown, Send } from 'lucide-react';

interface ProfileBulkActionsProps {
  isBatchDropOpen: boolean;
  setIsBatchDropOpen: (v: boolean) => void;
  selectedIds: Set<string>;
  handleBatchAction: (action: string) => void;
  batchFetchTokens: (ids: string[]) => void;
  setIsBulkEditOpen: (v: boolean) => void;
  handleExport: () => void;
  batchCheckBM: (ids: string[]) => void;
  setIsSmartPublishOpen: (v: boolean) => void;
  setIsGoogleAdPublisherOpen: (v: boolean) => void;
  setIsSetFbLangOpen: (v: boolean) => void;
  platform: Platform;
  setIsTikTokRegOpen: (v: boolean) => void;
  setIsXRegOpen: (v: boolean) => void;
  setIsInsRegOpen: (v: boolean) => void;
  setIsFBRegOpen: (v: boolean) => void;
}

export const ProfileBulkActions: React.FC<ProfileBulkActionsProps> = ({
  isBatchDropOpen,
  setIsBatchDropOpen,
  selectedIds,
  handleBatchAction,
  batchFetchTokens,
  setIsBulkEditOpen,
  handleExport,
  batchCheckBM,
  setIsSmartPublishOpen,
  setIsGoogleAdPublisherOpen,
  setIsSetFbLangOpen,
  platform,
  setIsTikTokRegOpen,
  setIsXRegOpen,
  setIsInsRegOpen,
  setIsFBRegOpen,
}) => {
  const { t } = useTranslation();

  return (
    <div className="relative">
      <button onClick={() => setIsBatchDropOpen(v => !v)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-600/20">
        <span className="bg-indigo-500 text-white text-xs font-bold px-2 py-0.5 rounded-md">{selectedIds.size}</span> 批量操作 <ChevronDown className={`w-4 h-4 transition-transform ${isBatchDropOpen ? 'rotate-180' : ''}`} />
      </button>
      {isBatchDropOpen && (<>
        <div className="fixed inset-0 z-40" onClick={() => setIsBatchDropOpen(false)} />
        <div className="absolute right-0 top-full mt-2 z-50 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 min-w-[220px] max-h-[70vh] overflow-y-auto">
          <div className="px-3 pt-2 pb-1"><span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">浏览器</span></div>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('start'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-emerald-400 hover:bg-emerald-500/20"><Play className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.launch')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('stop'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><Square className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.stop')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); batchFetchTokens(Array.from(selectedIds)); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><Key className="w-4 h-4 shrink-0 opacity-70" />批量获取TOKEN</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('relogin'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><LogIn className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.relogin')}</button>
          <div className="mx-3 my-1 border-t border-slate-700" />
          <div className="px-3 pt-2 pb-1"><span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">数据</span></div>
          <button onClick={() => { setIsBatchDropOpen(false); setIsBulkEditOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><Pencil className="w-4 h-4 shrink-0 opacity-70" />批量编辑</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('check'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><ShieldCheck className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.checkStatus')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('getInfo'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><RefreshCw className="w-4 h-4 shrink-0 opacity-70" />获取信息</button>
          {platform === Platform.META && <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('fetchPosts'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><FileText className="w-4 h-4 shrink-0 opacity-70" />拉取贴文</button>}
          <button onClick={() => { setIsBatchDropOpen(false); batchCheckBM(Array.from(selectedIds)); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><ShieldCheck className="w-4 h-4 shrink-0 opacity-70" />检测BM</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleExport(); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><Download className="w-4 h-4 shrink-0 opacity-70" />导出选中项</button>
          <div className="mx-3 my-1 border-t border-slate-700" />
          <div className="px-3 pt-2 pb-1"><span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">创建</span></div>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('createPage'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-blue-400 hover:bg-blue-500/20"><FileText className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.createPage')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('createBM'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-blue-400 hover:bg-blue-500/20"><Briefcase className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.createBM')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('createAdAccount'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-blue-400 hover:bg-blue-500/20"><CreditCard className="w-4 h-4 shrink-0 opacity-70" />{t('profileManager.batch.createAdAccount')}</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('publishAds'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-blue-400 hover:bg-blue-500/20"><Send className="w-4 h-4 shrink-0 opacity-70" />{platform === Platform.GOOGLE ? 'Google Ads 发布' : '发布广告'}</button>
          <button onClick={() => { setIsBatchDropOpen(false); setIsSmartPublishOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-amber-400 hover:bg-amber-500/20"><Upload className="w-4 h-4 shrink-0 opacity-70" />一键智能广告发布</button>
          {platform === Platform.GOOGLE && <button onClick={() => { setIsBatchDropOpen(false); setIsGoogleAdPublisherOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-emerald-400 hover:bg-emerald-500/20"><Send className="w-4 h-4 shrink-0 opacity-70" />Google Ads 批量创建</button>}
          <div className="mx-3 my-1 border-t border-slate-700" />
          <div className="px-3 pt-2 pb-1"><span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">操作</span></div>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('share'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-200 hover:bg-slate-700/50"><Share2 className="w-4 h-4 shrink-0 opacity-70" />分享配置</button>
          <button onClick={() => { setIsBatchDropOpen(false); setIsSetFbLangOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-sky-400 hover:bg-sky-500/20"><Globe className="w-4 h-4 shrink-0 opacity-70" />修改FB语言</button>
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('joinBM'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-indigo-400 hover:bg-indigo-500/20"><UserPlus className="w-4 h-4 shrink-0 opacity-70" />接入BM</button>
          <div className="mx-3 my-1 border-t border-slate-700" />
          <button onClick={() => { setIsBatchDropOpen(false); handleBatchAction('delete'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rose-400 hover:bg-rose-500/20"><Trash2 className="w-4 h-4 shrink-0 opacity-70" />⚠ {t('profileManager.batch.delete')}</button>
          {platform === Platform.TIKTOK && (<><div className="mx-3 my-1 border-t border-slate-700" /><button onClick={() => { setIsBatchDropOpen(false); setIsTikTokRegOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rose-400 hover:bg-rose-500/20"><PlusCircle className="w-4 h-4 shrink-0 opacity-70" />TikTok 批量注册</button></>)}
          {platform === Platform.X && (<><div className="mx-3 my-1 border-t border-slate-700" /><button onClick={() => { setIsBatchDropOpen(false); setIsXRegOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-sky-400 hover:bg-sky-500/20"><PlusCircle className="w-4 h-4 shrink-0 opacity-70" />X 批量注册</button></>)}
          {platform === Platform.INSTAGRAM && (<><div className="mx-3 my-1 border-t border-slate-700" /><button onClick={() => { setIsBatchDropOpen(false); setIsInsRegOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-purple-400 hover:bg-purple-500/20"><PlusCircle className="w-4 h-4 shrink-0 opacity-70" />Ins 批量注册</button></>)}
          {platform === Platform.META && (<><div className="mx-3 my-1 border-t border-slate-700" /><button onClick={() => { setIsBatchDropOpen(false); setIsFBRegOpen(true); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-blue-400 hover:bg-blue-500/20"><PlusCircle className="w-4 h-4 shrink-0 opacity-70" />FB 批量注册</button></>)}
        </div>
      </>)}
    </div>
  );
};
