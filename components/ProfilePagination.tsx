import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ProfilePaginationProps {
  currentPage: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  pageCount: number;
  totalItems: number;
  serverError: string | null;
  serverPageLoading: boolean;
  jumpPage: string;
  setJumpPage: (v: string) => void;
  fetchServerPage: (page: number, size: number) => void;
}

export const ProfilePagination: React.FC<ProfilePaginationProps> = ({
  currentPage,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageCount,
  totalItems,
  serverError,
  serverPageLoading,
  jumpPage,
  setJumpPage,
  fetchServerPage,
}) => {
  // 「跳至第 N 页」应用（回车/点按钮共用）：空值或非法值不跳转
  const applyJump = () => {
    const raw = String(jumpPage).trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) return;
    onPageChange(Math.min(pageCount, Math.max(1, Math.floor(n))));
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-900 border border-slate-800 rounded-xl">
      <div className="text-sm text-slate-400">
        {serverError ? (
          <span className="inline-flex items-center gap-2 text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            {serverError}
            <button onClick={() => fetchServerPage(currentPage, pageSize)} className="ml-1 text-indigo-400 hover:text-indigo-300 underline">重试</button>
          </span>
        ) : (
          <>共 {totalItems} 项，{pageCount} 页</>
        )}，每页{serverPageLoading ? <span className="ml-1 inline-block w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin align-middle" /> : null}
        <select value={pageSize} onChange={e => { onPageSizeChange(Math.min(1000, Number(e.target.value))); onPageChange(1); }} className="ml-2 bg-slate-950 border border-slate-700 text-slate-200 rounded px-2 py-1">
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onPageChange(1)} disabled={currentPage === 1} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50">首页</button>
        <button onClick={() => onPageChange(Math.max(1, currentPage - 1))} disabled={currentPage === 1} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50">上一页</button>
        {Array.from({length: Math.min(5, pageCount)}, (_,i)=>{
          const from = Math.max(1, currentPage - 2);
          const idx = from + i;
          return idx <= pageCount ? (
            <button key={idx} onClick={() => onPageChange(idx)} className={`px-2.5 py-1.5 rounded ${currentPage===idx ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{idx}</button>
          ) : null;
        })}
        <button onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))} disabled={currentPage === pageCount} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50">下一页</button>
        <button onClick={() => onPageChange(pageCount)} disabled={currentPage === pageCount} className="px-2.5 py-1.5 rounded bg-slate-800 text-slate-300 disabled:opacity-50">末页</button>
        <div className="flex items-center gap-2 ml-2">
          <input type="number" min={1} max={pageCount} value={jumpPage} onChange={e => setJumpPage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyJump(); } }}
            title="输入页码后按回车或点「跳转」"
            className="w-16 bg-slate-950 border border-slate-700 text-slate-200 rounded px-2 py-1" />
          <button onClick={applyJump} className="px-2.5 py-1.5 rounded bg-indigo-600 text-white">跳转</button>
        </div>
      </div>
    </div>
  );
};
