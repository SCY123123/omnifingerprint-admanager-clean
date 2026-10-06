import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2, Search, Filter, ChevronLeft, ChevronRight, Terminal, AlertCircle, AlertTriangle, Info } from 'lucide-react';

interface LogEntry {
  id: string;
  profile_id: string;
  level: string;
  message: string;
  created_at: string;
}

interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const LEVEL_COLORS: Record<string, string> = {
  INFO: 'text-blue-400 bg-blue-400/10',
  WARN: 'text-yellow-400 bg-yellow-400/10',
  ERROR: 'text-red-400 bg-red-400/10',
  SUCCESS: 'text-green-400 bg-green-400/10',
};

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  INFO: <Info size={14} />,
  WARN: <AlertTriangle size={14} />,
  ERROR: <AlertCircle size={14} />,
  SUCCESS: <Info size={14} />,
};

export const BrowserLogs: React.FC = () => {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
  const [profiles, setProfiles] = useState<string[]>([]);
  const [users, setUsers] = useState<{ userId: number; email: string }[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [userEmailFilter, setUserEmailFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [clearing, setClearing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams({
        page: String(pagination.page),
        pageSize: String(pagination.pageSize),
      });
      if (levelFilter) params.set('level', levelFilter);
      if (profileFilter) params.set('profileId', profileFilter);
      if (userEmailFilter) params.set('userEmail', userEmailFilter);
      if (searchKeyword) params.set('keyword', searchKeyword);

      const resp = await fetch(`/api/logs?${params}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      const data = await resp.json();
      if (data.success) {
        setLogs(data.data || []);
        setPagination(data.pagination);
        if (data.profiles) setProfiles(data.profiles);
        if (data.users) setUsers(data.users);
      } else {
        setError(data.message || 'Failed to fetch logs');
      }
    } catch (e: any) {
      setError(e.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, levelFilter, profileFilter, userEmailFilter, searchKeyword]);

  // 初始加载
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, [fetchLogs, autoRefresh]);

  const handleClear = async () => {
    if (!window.confirm('确定清除所有日志？此操作不可恢复。')) return;
    setClearing(true);
    try {
      const resp = await fetch('/api/logs/clear', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      const data = await resp.json();
      if (data.success) {
        setLogs([]);
        setPagination(prev => ({ ...prev, total: 0, page: 1, totalPages: 0 }));
      } else {
        alert('清除失败: ' + (data.message || ''));
      }
    } catch (e: any) {
      alert('清除失败: ' + e.message);
    } finally {
      setClearing(false);
    }
  };

  const handleSearch = () => {
    setPagination(prev => ({ ...prev, page: 1 }));
    setSearchKeyword(keyword);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts + (ts.includes('Z') || ts.includes('+') || ts.includes(' ') ? '' : 'Z'));
      return d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ts; }
  };

  return (
    <div className="flex flex-col h-full text-slate-200">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Terminal size={18} className="text-indigo-400" />
          <h2 className="text-sm font-semibold">浏览器执行日志</h2>
          {pagination.total > 0 && (
            <span className="text-xs text-slate-500 ml-2">共 {pagination.total} 条</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-indigo-500" />
            自动刷新
          </label>
          <button onClick={fetchLogs} className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors" title="刷新">
            <RefreshCw size={14} className={`${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={handleClear} disabled={clearing} className="p-1.5 hover:bg-red-900/30 rounded-lg transition-colors text-red-400" title="清除所有日志">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-slate-900/50 border-b border-slate-800/50">
        <div className="flex items-center gap-1 bg-slate-800 rounded-lg px-2 py-1.5 flex-1 max-w-md">
          <Search size={14} className="text-slate-500" />
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索日志内容..."
            className="bg-transparent border-none outline-none text-xs text-slate-200 flex-1 placeholder-slate-600"
          />
          <button onClick={handleSearch} className="text-xs text-indigo-400 hover:text-indigo-300 px-1">搜索</button>
        </div>
        <Filter size={14} className="text-slate-500" />
        <select
          value={levelFilter}
          onChange={e => { setLevelFilter(e.target.value); setPagination(prev => ({ ...prev, page: 1 })); }}
          className="bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1.5 text-slate-300 outline-none"
        >
          <option value="">全部级别</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
          <option value="SUCCESS">SUCCESS</option>
        </select>
        <select
          value={profileFilter}
          onChange={e => { setProfileFilter(e.target.value); setPagination(prev => ({ ...prev, page: 1 })); }}
          className="bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1.5 text-slate-300 outline-none max-w-[150px]"
        >
          <option value="">全部配置</option>
          {profiles.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="relative max-w-[180px]">
          <input
            type="text"
            list="userEmailList"
            value={userEmailFilter}
            onChange={e => { setUserEmailFilter(e.target.value); setPagination(prev => ({ ...prev, page: 1 })); }}
            placeholder="输入/选择邮箱..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1.5 text-slate-300 outline-none focus:border-indigo-500 placeholder-slate-600"
          />
          <datalist id="userEmailList">
            {users.map(u => <option key={u.userId} value={u.email} />)}
          </datalist>
        </div>
      </div>

      {/* Log List */}
      <div ref={containerRef} className="flex-1 h-0 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            <RefreshCw size={16} className="animate-spin mr-2" />
            加载中...
          </div>
        ) : error && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 text-sm gap-2">
            <Terminal size={32} className="opacity-30" />
            <span>暂无日志</span>
          </div>
        ) : (
          <div className="font-mono text-[11px] leading-relaxed">
            {logs.map((log, idx) => (
              <div
                key={log.id}
                className={`flex items-start gap-2 px-3 py-1 border-b border-slate-800/30 hover:bg-slate-800/30 transition-colors ${
                  log.level === 'ERROR' ? 'bg-red-900/10' : log.level === 'WARN' ? 'bg-yellow-900/10' : ''
                }`}
              >
                <span className="text-slate-600 w-14 flex-shrink-0 text-[10px] pt-0.5 text-right">
                  {idx + 1 + (pagination.page - 1) * pagination.pageSize}
                </span>
                <span className="text-slate-500 w-32 flex-shrink-0 text-[10px] pt-0.5 font-mono">
                  {formatTime(log.created_at)}
                </span>
                {log.owner_name && (
                  <span className="text-amber-400/70 flex-shrink-0 text-[10px] pt-0.5 max-w-[80px] truncate" title={log.owner_name}>
                    {log.owner_name}
                  </span>
                )}
                {log.owner_email && (
                  <span className="text-emerald-400/60 flex-shrink-0 text-[10px] pt-0.5 max-w-[130px] truncate" title={log.owner_email}>
                    {log.owner_email}
                  </span>
                )}
                <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${LEVEL_COLORS[log.level] || 'text-slate-400 bg-slate-800'}`}>
                  {log.level}
                </span>
                {log.profile_id && (
                  <span className="text-indigo-400/70 flex-shrink-0 text-[10px] pt-0.5">[{log.profile_id}]</span>
                )}
                <span className="text-slate-300 break-all min-w-0 pt-0.5">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-slate-900 border-t border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">
            {pagination.total > 0
              ? `第 ${(pagination.page - 1) * pagination.pageSize + 1}-${Math.min(pagination.page * pagination.pageSize, pagination.total)} 条，共 ${pagination.total} 条`
              : '暂无数据'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            disabled={pagination.page <= 1}
            onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
            className="p-1 hover:bg-slate-800 rounded disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
          </button>
          {Array.from({ length: Math.min(pagination.totalPages, 5) }, (_, i) => {
            const start = Math.max(1, Math.min(pagination.page - 2, pagination.totalPages - 4));
            const pageNum = start + i;
            if (pageNum > pagination.totalPages) return null;
            return (
              <button
                key={pageNum}
                onClick={() => setPagination(prev => ({ ...prev, page: pageNum }))}
                className={`px-2 py-0.5 rounded text-xs ${pageNum === pagination.page ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 text-slate-400'}`}
              >
                {pageNum}
              </button>
            );
          })}
          <button
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
            className="p-1 hover:bg-slate-800 rounded disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default BrowserLogs;
