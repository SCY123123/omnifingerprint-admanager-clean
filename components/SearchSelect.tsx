import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';

export interface SearchOption {
  value: string;
  /** 主标题（下拉条目和已选值都显示这个） */
  label: string;
  /** 第二行小字（可选） */
  sub?: string;
  /** 额外参与搜索的文本（可选） */
  keywords?: string;
}

interface SearchSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SearchOption[];
  placeholder?: string;
  /** 选项为空时的提示 */
  emptyText?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  className?: string;
}

/**
 * 可搜索的下拉选择器。
 * 系统里的配置可能有几百条、BM 也会有很多，原生 <select> 既难找也不能搜，所以统一用这个。
 * 搜索范围 = value + label + sub + keywords（即 ID / 名称 / 归属配置都能搜）。
 */
export const SearchSelect: React.FC<SearchSelectProps> = ({
  value, onChange, options, placeholder = '请选择', emptyText = '暂无可选项',
  disabled, searchPlaceholder = '输入名称或 ID 搜索', className = ''
}) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) { setQ(''); return; }
    const onDocDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const LIMIT = 200;
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const src = kw
      ? options.filter(o => `${o.value} ${o.label} ${o.sub || ''} ${o.keywords || ''}`.toLowerCase().includes(kw))
      : options;
    return src.slice(0, LIMIT);
  }, [q, options]);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 bg-slate-950 border border-slate-700 text-left text-slate-200 px-3 py-2 rounded-lg text-sm disabled:opacity-50 focus:ring-2 focus:ring-indigo-500 outline-none"
      >
        <span className={`truncate ${selected ? '' : 'text-slate-500'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-2xl shadow-black/50">
          <div className="p-2 border-b border-slate-700">
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded px-2 py-1.5">
              <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={searchPlaceholder}
                className="flex-1 bg-transparent text-slate-200 text-sm outline-none"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-500">
                {options.length === 0 ? emptyText : '没有匹配项'}
              </div>
            ) : filtered.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 ${o.value === value ? 'bg-indigo-600/20 text-indigo-300' : 'text-slate-200'}`}
              >
                <div className="truncate">{o.label}</div>
                {o.sub && <div className="text-[11px] text-slate-500 truncate">{o.sub}</div>}
              </button>
            ))}
            {filtered.length >= LIMIT && (
              <div className="px-3 py-1.5 text-[11px] text-slate-500 border-t border-slate-700">
                仅显示前 {LIMIT} 条，继续输入关键词可缩小范围
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 系统的 BM 列表（供「授权到 BM / 分享合作伙伴 / 认领广告号」这类 BM 选择器用）。
 * 先吃 localStorage 缓存（业务列表页刷新时会写 cache:businesses）再向云端刷新，
 * 完全复用「BM 列表」页的数据源，不额外造接口。
 */
export function useBusinessOptions(token?: string | null): { options: SearchOption[]; list: any[] } {
  const [list, setList] = useState<any[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('cache:businesses');
      const cached = raw ? JSON.parse(raw) : [];
      if (Array.isArray(cached) && cached.length) setList(cached);
    } catch {}
    let cancelled = false;
    (async () => {
      try {
        let sbase = ((import.meta as any).env?.VITE_STORAGE_SERVER_URL || '/').replace(/\/$/, '');
        try { if (sbase && (/localhost|127\.0\.0\.1/i.test(sbase) || /api\.adpos\.io/i.test(sbase))) sbase = ''; } catch {}
        const authToken = token || localStorage.getItem('auth_token');
        const resp = await fetch(`${sbase}/api/businesses`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const json = await resp.json();
        if (!cancelled && json?.success && Array.isArray(json.data) && json.data.length) setList(json.data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [token]);

  const options = useMemo<SearchOption[]>(() => {
    const seen = new Set<string>();
    const out: SearchOption[] = [];
    for (const b of list) {
      const id = String(b.businessId || b.business_id || b.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(b.name || b.bmName || '').trim();
      const profName = String(b.profileName || b.profile_name || '').trim();
      out.push({
        value: id,
        label: name ? `${name} · ${id}` : id,
        sub: profName ? `配置 ${profName}` : undefined,
        keywords: `${id} ${name} ${profName}`
      });
    }
    return out;
  }, [list]);

  return { options, list };
}
