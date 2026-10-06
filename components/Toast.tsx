import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  // 全局覆盖 window.alert + 全局未捕获错误处理
  useEffect(() => {
    const originalAlert = window.alert.bind(window);
    window.alert = (message: string) => {
      showToast(String(message), 'error');
    };
    // 全局未捕获 Promise 错误
    const handleRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message || String(e.reason) || '未知错误';
      showToast(`未捕获错误: ${msg}`, 'error');
    };
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.alert = originalAlert;
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast 容器 — 固定定位浮层 */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={[
              'pointer-events-auto px-4 py-3 rounded-lg shadow-lg border max-w-sm',
              'text-sm font-medium animate-in slide-in-from-right',
              t.type === 'success' && 'bg-emerald-900/90 border-emerald-700 text-emerald-200',
              t.type === 'error' && 'bg-rose-900/90 border-rose-700 text-rose-200',
              t.type === 'info' && 'bg-indigo-900/90 border-indigo-700 text-indigo-200',
              t.type === 'warning' && 'bg-amber-900/90 border-amber-700 text-amber-200',
            ].filter(Boolean).join(' ')}
          >
            <div className="flex items-center gap-2">
              <span className="flex-shrink-0">
                {t.type === 'success' && '✓'}
                {t.type === 'error' && '✕'}
                {t.type === 'info' && 'ℹ'}
                {t.type === 'warning' && '⚠'}
              </span>
              <span className="break-words whitespace-pre-wrap">{t.message}</span>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateX(100%); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-in { animation: toast-in 0.25s ease-out; }
      `}</style>
    </ToastContext.Provider>
  );
};
