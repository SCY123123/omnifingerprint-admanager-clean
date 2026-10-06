import React from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserStatus, FingerprintProfile } from '../types';
import { Play, Square, Pencil, Wallet, ShieldCheck, LogIn, FileText, AlertTriangle, RefreshCw, Globe, Monitor, Copy, Eye, EyeOff, ArrowUp, ArrowDown } from 'lucide-react';
import { jumpToPosts, jumpToMessages } from './PageSocialViewers';
import { loginStatusView } from './assetRowHelpers';

interface ProfileTableProps {
  paginatedProfiles: FingerprintProfile[];
  selectedIds: Set<string>;
  allPageSelected: boolean;
  pageSize: number;
  searchTerm: string;
  serverError: string | null;
  serverPageLoading: boolean;
  sortConfig: { key: string; direction: 'asc' | 'desc' };
  visiblePasswords: Set<string>;
  visibleTwoFA: Set<string>;
  enableTotp: boolean;
  totpMap: Record<string, { code: string; left: number }>;
  loginMap: Record<string, 'in' | 'out' | 'unknown'>;
  profileAdAccounts: Record<string, any[]>;
  contentCounts?: Record<string, { posts: number; messages: number }>;
  getPaymentStatusBadge: (status?: 'Active' | 'Failed' | 'None', cardInfo?: string) => React.ReactNode;
  onToggleSelectAll: () => void;
  onToggleSelect: (id: string) => void;
  onToggleStatus: (id: string) => Promise<void>;
  onSort: (key: string) => void;
  onViewLogs: (profile: FingerprintProfile) => void;
  onGetAndSaveTokens: (id: string) => Promise<void>;
  onCheckLoginStatus: (id: string) => void;
  onAutofillLogin: (id: string) => void;
  onEditProfile: (id: string) => Promise<void>;
  onSetEditingNotes: (data: { id: string; notes: string }) => void;
  onCopyText: (text: string) => void;
  onTogglePasswordVisibility: (id: string) => void;
  onToggleTwoFAVisibility: (id: string) => void;
  onRetry: () => void;
}

const SortableHeader = ({ label, sortKey, className, sortConfig, onSort }: {
  label: string;
  sortKey: string;
  className?: string;
  sortConfig: { key: string; direction: 'asc' | 'desc' };
  onSort: (key: string) => void;
}) => (
  <th className={`px-6 py-4 whitespace-nowrap cursor-pointer group ${className}`} onClick={() => onSort(sortKey)}>
    <div className="flex items-center gap-1">
      {label}
      {sortConfig.key === sortKey ? (
        sortConfig.direction === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />
      ) : <div className="w-3.5 h-3.5 opacity-0 group-hover:opacity-50"><ArrowDown/></div>}
    </div>
  </th>
);

export const ProfileTable = ({
  paginatedProfiles,
  selectedIds,
  allPageSelected,
  pageSize,
  searchTerm,
  serverError,
  serverPageLoading,
  sortConfig,
  visiblePasswords,
  visibleTwoFA,
  enableTotp,
  totpMap,
  loginMap,
  profileAdAccounts,
  contentCounts,
  getPaymentStatusBadge,
  onToggleSelectAll,
  onToggleSelect,
  onToggleStatus,
  onSort,
  onViewLogs,
  onGetAndSaveTokens,
  onCheckLoginStatus,
  onAutofillLogin,
  onEditProfile,
  onSetEditingNotes,
  onCopyText,
  onTogglePasswordVisibility,
  onToggleTwoFAVisibility,
  onRetry,
}: ProfileTableProps) => {
  const { t } = useTranslation();
  const pageItems = paginatedProfiles;

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
      {/* Universal Table View */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead className="bg-slate-950 text-slate-400 font-medium">
            <tr>
              <th className="px-4 py-2.5 w-10">
                <input 
                  type="checkbox" 
                  checked={allPageSelected}
                  onChange={onToggleSelectAll}
                  disabled={pageItems.length === 0}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900 disabled:opacity-50"
                />
              </th>
              <SortableHeader label={t('profileManager.table.id')} sortKey="id" sortConfig={sortConfig} onSort={onSort} />
              <th className="px-4 py-2.5 whitespace-nowrap text-center">日志</th>
              <SortableHeader label={t('profileManager.table.importedAt')} sortKey="updatedAt" sortConfig={sortConfig} onSort={onSort} />
              <th className="px-6 py-4 text-right whitespace-nowrap">{t('profileManager.table.actions')}</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden xl:table-cell">{t('profileManager.table.notes')}</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden xl:table-cell">Token</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">分组</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">标签</th>
              <SortableHeader label={t('profileManager.table.name')} sortKey="name" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label="归属名称" sortKey="ownerName" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label="归属邮箱" sortKey="ownerEmail" sortConfig={sortConfig} onSort={onSort} />
              
              <SortableHeader label={t('profileManager.table.account')} sortKey="account.name" sortConfig={sortConfig} onSort={onSort} />
              <th className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">{t('profileManager.table.email')}</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden xl:table-cell">{t('profileManager.table.password')}</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden xl:table-cell">{t('profileManager.table.twofa')}</th>
              <SortableHeader label={t('profileManager.table.country')} sortKey="assets.country" className="hidden md:table-cell" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label={t('profileManager.table.bmId')} sortKey="assets.bmId" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label={'BM数量'} sortKey="assets.bmCount" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label={'像素'} sortKey="assets.pixelsCount" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label={t('profileManager.table.pages')} sortKey="assets.pagesCount" sortConfig={sortConfig} onSort={onSort} />
              <SortableHeader label={t('profileManager.table.adAccounts')} sortKey="assets.adAccountsCount" sortConfig={sortConfig} onSort={onSort} />
              <th className="px-4 py-2.5 whitespace-nowrap text-center">广告贴文</th>
              <th className="px-4 py-2.5 whitespace-nowrap text-center">消息对话</th>
              <th className="px-4 py-2.5 whitespace-nowrap hidden md:table-cell">{t('profileManager.table.payment')}</th>
              <th className="px-4 py-2.5 whitespace-nowrap">登录状态</th>
              <SortableHeader label={t('profileManager.table.status')} sortKey="status" sortConfig={sortConfig} onSort={onSort} />
              
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {pageItems.length > 0 ? pageItems.map((profile, index) => (
              <tr key={profile.id} className={`hover:bg-slate-800/50 transition-all duration-200 row-fade-slide-in ${selectedIds.has(profile.id) ? 'bg-indigo-900/10' : ''}`} style={{ animationDelay: `${(index % pageSize) * 30}ms` }}>
                <td className="px-4 py-2.5">
                   <input 
                    type="checkbox" 
                    checked={selectedIds.has(profile.id)}
                    onChange={() => onToggleSelect(profile.id)}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900"
                  />
                </td>
                <td className="px-4 py-2.5 text-center text-slate-500 font-mono cursor-pointer hover:text-indigo-400 hover:underline transition-colors" onClick={() => { try { localStorage.setItem('adAccounts:searchPrefill', String(profile.id||'')); } catch {} try { (window as any).setActiveTab && (window as any).setActiveTab('meta-adAccounts'); } catch {} }}>{profile.id ?? ''}</td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => onViewLogs(profile)}
                    className="p-1.5 text-indigo-400 hover:text-white hover:bg-indigo-600/20 rounded transition-colors inline-flex items-center gap-1"
                    title="查看日志"
                  >
                    <FileText className="w-4 h-4" />
                    <span className="text-[10px]">查看</span>
                  </button>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-slate-400 text-sm">
                  {(() => {
                    const raw = (profile as any).updatedAt;
                    if (!raw) return '-';
                    try {
                      const d = new Date(raw);
                      if (isNaN(d.getTime())) return raw;
                      const y = d.getFullYear();
                      const m = String(d.getMonth() + 1).padStart(2, '0');
                      const day = String(d.getDate()).padStart(2, '0');
                      const h = String(d.getHours()).padStart(2, '0');
                      const mi = String(d.getMinutes()).padStart(2, '0');
                      const s = String(d.getSeconds()).padStart(2, '0');
                      return `${y}-${m}-${day} ${h}:${mi}:${s}`;
                    } catch {
                      return raw;
                    }
                  })()}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => onToggleStatus(profile.id)}
                      className={`p-2 rounded-lg transition-colors ${
                        profile.status === BrowserStatus.RUNNING
                          ? 'bg-rose-900/20 text-rose-400 hover:bg-rose-900/40'
                          : 'bg-emerald-900/20 text-emerald-400 hover:bg-emerald-900/40'
                      }`}
                      title={profile.status === BrowserStatus.RUNNING ? t('profileManager.actions.stop') : t('profileManager.actions.launchLocal')}
                    >
                      {profile.status === BrowserStatus.RUNNING ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                    </button>
                    <button
                      onClick={() => onEditProfile(profile.id)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                      title={t('profileManager.actions.edit')}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onGetAndSaveTokens(profile.id)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                      title="获取TOKEN并保存"
                    >
                      <Wallet className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onCheckLoginStatus(profile.id)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                      title="检查登录状态"
                    >
                      <ShieldCheck className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onAutofillLogin(profile.id)}
                      className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                      title="自动填充登录"
                    >
                      <LogIn className="w-4 h-4" />
                    </button>
                  </div>
                </td>
                <td className="px-4 py-2.5 max-w-[200px] hidden xl:table-cell">
                  <div className="flex items-center gap-1 group">
                    <p className="truncate text-slate-400 flex-1 min-w-0" title={profile.notes}>
                      {profile.notes || <span className="text-slate-600">-</span>}
                    </p>
                    <button onClick={() => onSetEditingNotes({ id: profile.id, notes: profile.notes || '' })}
                      className="p-1 text-slate-600 hover:text-white hover:bg-slate-800 rounded opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="编辑备注">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                  </div>
                </td>
                <td className="px-4 py-2.5 max-w-[200px] hidden xl:table-cell">
                   <p className="truncate text-slate-400 font-mono text-xs" title={profile.token || ''}>
                      {profile.token ? `${profile.token.substring(0, 30)}...` : <span className="text-slate-600">-</span>}
                   </p>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-indigo-900/30 text-indigo-300">
                    {profile.group || <span className="text-slate-600">-</span>}
                  </span>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {(profile.tags ?? []).length > 0 ? (profile.tags ?? []).map((tag, i) => (
                      <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-900/20 text-emerald-300">
                        {tag}
                      </span>
                    )) : <span className="text-slate-600">-</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-indigo-900/50 flex items-center justify-center text-indigo-400 shrink-0">
                      <Monitor className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="font-medium text-white whitespace-nowrap">{profile.name}</p>
                      <div className="flex items-center gap-2 text-xs text-slate-500 whitespace-nowrap">
                         <span className="font-mono">{profile.ipAddress}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-xs">{profile.ownerName || '-'}</span>
                </td>
                <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                  <span className="text-xs text-slate-500">{profile.ownerEmail || '-'}</span>
                </td>
                
                <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap hidden md:table-cell">
                  {profile.account?.name ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>{profile.account.name}</span>
                      <div className="flex items-center gap-2 lg:hidden">
                        {profile.account?.password && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-slate-200">
                            <span className="text-xs text-slate-400">密码</span>
                            <span className="font-mono">{visiblePasswords.has(profile.id) ? profile.account.password : '******'}</span>
                            <button onClick={() => onTogglePasswordVisibility(profile.id)} className="p-1 rounded hover:bg-slate-700" title={visiblePasswords.has(profile.id) ? '隐藏' : '显示'}>
                              {visiblePasswords.has(profile.id) ? <EyeOff className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
                            </button>
                            <button onClick={() => onCopyText(profile.account!.password!)} className="p-1 rounded hover:bg-slate-700" title="复制"><Copy className="w-4 h-4"/></button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap hidden lg:table-cell">
                  {profile.account?.email ? (
                    <div className="flex items-center gap-2">
                      <span>{profile.account.email}</span>
                      <button onClick={() => onCopyText(profile.account!.email!)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title="复制">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 hidden xl:table-cell">
                  {profile.account?.password ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{visiblePasswords.has(profile.id) ? profile.account.password : '******'}</span>
                      <button onClick={() => onTogglePasswordVisibility(profile.id)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title={visiblePasswords.has(profile.id) ? '隐藏' : '显示'}>
                        {visiblePasswords.has(profile.id) ? <EyeOff className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
                      </button>
                      <button onClick={() => onCopyText(profile.account!.password!)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title="复制">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 hidden xl:table-cell">
                  {enableTotp && totpMap[profile.id]?.code ? (
                    <div className="flex items-center gap-2">
                      <span className={`font-mono text-lg font-bold tracking-widest ${totpMap[profile.id].left <= 5 ? 'text-red-400' : 'text-indigo-300'}`}>{totpMap[profile.id].code}</span>
                      <span className="text-[10px] text-slate-500">{totpMap[profile.id].left}s</span>
                      <button onClick={() => onCopyText(totpMap[profile.id].code)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title="复制验证码">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ) : profile.account?.twoFactorSecret ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{visibleTwoFA.has(profile.id) ? profile.account.twoFactorSecret : '******'}</span>
                      <button onClick={() => onToggleTwoFAVisibility(profile.id)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title={visibleTwoFA.has(profile.id) ? '隐藏' : '显示'}>
                        {visibleTwoFA.has(profile.id) ? <EyeOff className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
                      </button>
                      <button onClick={() => onCopyText(profile.account!.twoFactorSecret!)} className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700" title="复制">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 font-mono hidden md:table-cell">{profile.assets?.country || <span className="text-slate-600">-</span>}</td>
                <td className="px-4 py-2.5 text-slate-300"><span className="font-mono">{(profile.assets?.bmIds && profile.assets?.bmIds.length > 0) ? profile.assets.bmIds.join(', ') : (profile.assets?.bmId || '-')}</span></td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  {(() => {
                    // bmIds 只在真有 ID 时才用它；否则退到 bmCount（空数组是 truthy，以前这里恒为 0）
                    const bmIdList = Array.isArray(profile.assets?.bmIds) ? profile.assets!.bmIds!.filter(Boolean) : [];
                    const bmCount = bmIdList.length > 0 ? bmIdList.length : (profile.assets?.bmCount ?? 0);
                    if (bmCount <= 0) return <span className="text-slate-500 font-mono">0</span>;
                    return (
                      <button
                        className="font-mono text-indigo-400 hover:text-indigo-300 underline"
                        title={bmIdList.length > 0 ? `${bmIdList.join(', ')}\n点击到 BM 列表查看` : '点击到 BM 列表查看该配置的 BM'}
                        onClick={() => {
                          // BM 列表的搜索同时匹配 BM ID / 配置ID / 名称 → 用配置ID预填就是「筛该配置的 BM」
                          try { localStorage.setItem('bmSearchPrefill', String(profile.id || '')); } catch {}
                          try { (window as any).setActiveTab && (window as any).setActiveTab('meta-bms'); } catch {}
                        }}
                      >
                        {bmCount}
                      </button>
                    );
                  })()}
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  <span className={`font-mono ${(profile.assets?.pixelsCount ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {profile.assets?.pixelsCount ?? 0}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  <button
                    className={`font-mono ${(profile.assets?.pagesCount ?? 0) > 0 ? 'text-indigo-400 hover:text-indigo-300 underline' : 'text-slate-500 cursor-default'}`}
                    onClick={() => {
                      if ((profile.assets?.pagesCount ?? 0) === 0) return;
                      try { localStorage.setItem('pagesFilter', JSON.stringify({ profileId: profile.id })); } catch {}
                      try { (window as any).setActiveTab && (window as any).setActiveTab('meta-pages'); } catch {}
                      window.dispatchEvent(new Event('pages-refresh'));
                    }}
                  >
                    {profile.assets?.pagesCount ?? 0}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  {/* 🚀 统一显示「广告号数量」：以前是「本地缓存里有明细 → 渲染成一堆后6位小标签，
                      没有明细 → 才显示数量」，于是刚点过「获取信息」的配置显示后6位、其它显示数字，
                      同一列两种语义。现在明细只放到悬停提示里（title），列内一律是数量。 */}
                  {(() => {
                    const acts = profileAdAccounts[profile.id];
                    const idsTip = Array.isArray(acts) && acts.length > 0
                      ? acts.map((a: any) => String(a.adAccountId || '')).filter(Boolean).join(', ')
                      : '';
                    const cnt = profile.assets?.adAccountsCount ?? 0;
                    return (
                      <button
                        className={`font-mono ${cnt > 0 ? 'text-indigo-400 hover:text-indigo-300 hover:underline' : 'text-slate-500 cursor-default'}`}
                        title={idsTip || '点击前往广告号列表'}
                        onClick={() => {
                          if (cnt === 0) return;
                          try { localStorage.setItem('adAccounts:searchPrefill', String(profile.id || '')); } catch {}
                          try { (window as any).setActiveTab && (window as any).setActiveTab('meta-adAccounts'); } catch {}
                        }}
                      >{cnt}</button>
                    );
                  })()}
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  {(contentCounts?.[String(profile.id)]?.posts ?? 0) > 0 ? (
                    <button
                      className="font-mono text-emerald-400 hover:text-emerald-300 underline"
                      onClick={() => jumpToPosts({ profileId: String(profile.id) })}
                      title="查看贴文"
                    >
                      {contentCounts?.[String(profile.id)]?.posts ?? 0}
                    </button>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-center">
                  {(contentCounts?.[String(profile.id)]?.messages ?? 0) > 0 ? (
                    <button
                      className="font-mono text-sky-400 hover:text-sky-300 underline"
                      onClick={() => jumpToMessages({ profileId: String(profile.id) })}
                      title="查看消息对话"
                    >
                      {contentCounts?.[String(profile.id)]?.messages ?? 0}
                    </button>
                  ) : <span className="text-slate-600">-</span>}
                </td>
                <td className="px-4 py-2.5 hidden md:table-cell">
                  <div className="flex flex-col gap-1 items-start">
                    {getPaymentStatusBadge(profile.assets?.paymentStatus, profile.assets?.paymentInfo)}
                    <div className="flex items-center gap-2">
                      {profile.assets?.currency && <span className="text-xs font-mono text-slate-500">{profile.assets.currency}</span>}
                      {profile.assets?.timezone && <span className="text-[10px] font-mono text-slate-500 bg-slate-800/50 px-1 rounded" title="时区">{profile.assets.timezone}</span>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  {/* 🔐 登录状态独立成列（以前挤在「状态」列里，一是不显眼，二是跟浏览器运行态混在一起容易被误读）。
                      优先用落库的 profile.loginStatus；为空时退回本次会话的 loginMap（批量检查只写它）。 */}
                  {(() => {
                    const raw = profile.loginStatus
                      || (loginMap[profile.id] === 'in' ? 'ok' : loginMap[profile.id] === 'out' ? 'invalid' : '');
                    const v = loginStatusView(raw);
                    return (
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${v.className}`}>
                        {v.label}
                      </span>
                    );
                  })()}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    profile.status === BrowserStatus.RUNNING
                      ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-900'
                      : 'bg-slate-800 text-slate-400 border border-slate-700'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                       profile.status === BrowserStatus.RUNNING ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                    }`}></span>
                    {profile.status}
                  </span>
                </td>
                
              </tr>
            )) : serverError ? (
              <tr>
                <td colSpan={27} className="text-center py-16">
                  <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-400" />
                  <div className="text-slate-400 mb-3">{serverError}</div>
                  <button
                    onClick={onRetry}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    重试
                  </button>
                </td>
              </tr>
            ) : !serverPageLoading ? (
              <tr>
                <td colSpan={27} className="text-center py-16 text-slate-500">
                  <Globe className="w-8 h-8 mx-auto mb-2" />
                  {searchTerm ? '未找到匹配的配置' : '该平台暂无配置'}
                </td>
              </tr>
            ) : (
              // 🚀 初始加载骨架屏
              Array.from({length: Math.min(5, pageSize)}).map((_, i) => (
                <tr key={`skeleton-${i}`}>
                  <td colSpan={27} className="px-2 py-2">
                    <div className="h-8 bg-slate-800/50 rounded animate-pulse" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>

  );
};
