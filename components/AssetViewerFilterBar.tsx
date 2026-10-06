import React from 'react';
import { Search } from 'lucide-react';
import { AdAccountAsset } from '../types';

interface AssetViewerFilterBarProps {
  assetType: 'pages' | 'bms' | 'adAccounts' | 'ads';
  Icon: React.ElementType;
  title: string;
  renderBatchActions: () => React.ReactNode;
  onBatchAction?: (action: string) => void;
  onRefresh?: () => void;
  onRefreshFromServer?: () => void;
  onCleanup?: () => void;
  onExport?: () => void;
  onRefreshBM?: () => void;
  onRefreshBMFromServer?: () => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  bmEmailFilter: string;
  onBmEmailFilterChange: (value: string) => void;
  profileEmailFilter: string;
  onProfileEmailFilterChange: (value: string) => void;
  onProfileEmailFilterClear: () => void;
  profileEmailOptions: string[];
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  currencyFilter: string;
  onCurrencyFilterChange: (value: string) => void;
  countryFilter: string;
  onCountryFilterChange: (value: string) => void;
  groupFilter: string;
  onGroupFilterChange: (value: string) => void;
  groupOptions: string[];
  tagFilter: string;
  onTagFilterChange: (value: string) => void;
  tagOptions: string[];
  adAccountsDb: AdAccountAsset[];
  bmRefreshInfo: string;
}

export const AssetViewerFilterBar: React.FC<AssetViewerFilterBarProps> = ({
  assetType,
  Icon,
  title,
  renderBatchActions,
  onBatchAction,
  onRefresh,
  onRefreshFromServer,
  onCleanup,
  onExport,
  onRefreshBM,
  onRefreshBMFromServer,
  searchTerm,
  onSearchChange,
  bmEmailFilter,
  onBmEmailFilterChange,
  profileEmailFilter,
  onProfileEmailFilterChange,
  onProfileEmailFilterClear,
  profileEmailOptions,
  statusFilter,
  onStatusFilterChange,
  currencyFilter,
  onCurrencyFilterChange,
  countryFilter,
  onCountryFilterChange,
  groupFilter,
  onGroupFilterChange,
  groupOptions,
  tagFilter,
  onTagFilterChange,
  tagOptions,
  adAccountsDb,
  bmRefreshInfo,
}) => {
  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white flex items-center gap-3">
          <Icon className="w-6 h-6 text-indigo-400" />
          {title}
        </h2>
        {assetType === 'adAccounts' && (
          <div className="flex items-center gap-2">
            <button onClick={onRefresh} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">刷新</button>
            <button onClick={onRefreshFromServer} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">后端刷新</button>
            <button onClick={onCleanup} className="px-3 py-1.5 rounded bg-rose-700 text-white hover:bg-rose-600 text-sm">清理未显示</button>
            <button onClick={onExport} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">导出</button>
          </div>
        )}
        {assetType === 'bms' && (
          <div className="flex items-center gap-2">
            <button onClick={() => onBatchAction?.('createBM')} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">创建BM</button>
            <button onClick={() => onBatchAction?.('createAdAccount')} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">创建广告账户</button>
            <button onClick={() => { try { onRefreshBM?.(); } catch {} }} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">刷新BM</button>
            <button onClick={onRefreshBMFromServer} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">后端刷新BM</button>
            <button onClick={onExport} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">导出</button>
          </div>
        )}
        {assetType === 'pages' && (
          <div className="flex items-center gap-2">
            <button onClick={() => onBatchAction?.('createPage')} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">创建主页</button>
            <button onClick={() => onBatchAction?.('grantPage')} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">授权给BM</button>
            <button onClick={onExport} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm">导出</button>
          </div>
        )}
        {renderBatchActions()}
        <div className="flex gap-2 flex-wrap items-center">
          <input
            type="text"
            placeholder="搜索（批量: 逗号/换行分隔）"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-[180px] bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm"
          />
          {assetType === 'bms' && (
            <input
              type="text"
              placeholder="管理员邮箱过滤"
              value={bmEmailFilter}
              onChange={(e) => onBmEmailFilterChange(e.target.value)}
              className="w-[150px] bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm"
            />
          )}
          {/* 🚀 超级管理员邮箱筛选：各标签页通用 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
            <input
              type="text"
              list="profileEmailList"
              placeholder="用户邮箱筛选"
              value={profileEmailFilter}
              onChange={e => onProfileEmailFilterChange(e.target.value)}
              className="w-[160px] bg-slate-950 border border-slate-700 text-slate-200 pl-8 pr-2 py-1.5 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm"
            />
            <datalist id="profileEmailList">
              {profileEmailOptions.map(email => <option key={email} value={email} />)}
            </datalist>
          </div>
          {profileEmailFilter && (
            <button
              onClick={onProfileEmailFilterClear}
              className="text-xs text-slate-500 hover:text-white transition-colors whitespace-nowrap"
            >
              清除
            </button>
          )}
          {/* 🚀 分组 / 标签 下拉筛选 */}
          {(groupOptions.length > 0 || groupFilter) && (
            <select
              value={groupFilter}
              onChange={e => onGroupFilterChange(e.target.value)}
              className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs max-w-[150px]"
              title="按分组筛选"
            >
              <option value="">全部分组</option>
              {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
          {(tagOptions.length > 0 || tagFilter) && (
            <select
              value={tagFilter}
              onChange={e => onTagFilterChange(e.target.value)}
              className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs max-w-[150px]"
              title="按标签筛选"
            >
              <option value="">全部标签</option>
              {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {assetType === 'adAccounts' && (
            <>
              <select value={statusFilter} onChange={e=>onStatusFilterChange(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs">
                <option value="">全部状态</option>
                <option value="Active">Active</option>
                <option value="In Review">In Review</option>
                <option value="Disabled">Disabled</option>
                <option value="Unsettled">Unsettled</option>
                <option value="Pending Risk Review">Pending Risk Review</option>
                <option value="Pending Settlement">Pending Settlement</option>
                <option value="In Grace Period">In Grace Period</option>
                <option value="Pending Closure">Pending Closure</option>
                <option value="Closed">Closed</option>
                <option value="Unknown">Unknown</option>
              </select>
              <select value={currencyFilter} onChange={e=>onCurrencyFilterChange(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs">
                <option value="">全部货币</option>
                {Array.from(new Set(adAccountsDb.map(a=>String(a.currency||'')).filter(Boolean))).map(cur=> (<option key={cur} value={cur}>{cur}</option>))}
              </select>
              <select value={countryFilter} onChange={e=>onCountryFilterChange(e.target.value)} className="bg-slate-950 border border-slate-700 text-slate-200 px-2 py-1.5 rounded text-xs">
                <option value="">全部国家</option>
                {Array.from(new Set(adAccountsDb.map(a=>String(a.country||'')).filter(Boolean))).map(cty=> (<option key={cty} value={cty}>{cty}</option>))}
              </select>
            </>
          )}
          {assetType === 'pages' && localStorage.getItem('pagesFilter') && (
            <button 
              onClick={() => {
                localStorage.removeItem('pagesFilter');
                window.dispatchEvent(new Event('pages-refresh'));
              }}
              className="px-2 py-1.5 bg-rose-600/20 text-rose-400 border border-rose-600/30 rounded-lg text-xs hover:bg-rose-600/30 transition-colors whitespace-nowrap"
            >
              清除
            </button>
          )}
        </div>
      </div>
      {assetType === 'bms' && bmRefreshInfo && (
        <p className="text-xs text-slate-500 mt-1">{bmRefreshInfo}</p>
      )}
    </div>
  );
};
