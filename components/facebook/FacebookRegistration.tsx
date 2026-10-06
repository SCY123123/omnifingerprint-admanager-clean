import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusCircle, Play, Loader2, CheckCircle2, AlertCircle, Users, Facebook } from 'lucide-react';

const LOCAL_SERVER_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

export const FacebookRegistration: React.FC<{ selectedProfileIds?: string[], onComplete?: () => void }> = ({ selectedProfileIds, onComplete }) => {
    const { t } = useTranslation();
    const [count, setCount] = useState<number>(selectedProfileIds?.length || 1);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [tasks, setTasks] = useState<any[]>([]);
    const [polling, setPolling] = useState(false);

    useEffect(() => {
        const fetchRecentTasks = async () => {
            try {
                const resp = await fetch('http://localhost:9999/api/fb/tasks-status', {
                    headers: { 'X-Api-Secret': LOCAL_SERVER_SECRET }
                });
                const data = await resp.json();
                if (data.success && data.tasks && data.tasks.length > 0) {
                    setTasks(data.tasks);
                    const hasRunning = data.tasks.some((t: any) => t.status === 'running' || t.status === 'pending');
                    if (hasRunning) setPolling(true);
                }
            } catch (err) {}
        };
        fetchRecentTasks();
    }, []);

    useEffect(() => {
        let timer: any;
        if (polling && tasks.length > 0) {
            timer = setInterval(async () => {
                 try {
                     const ids = tasks.map(t => t.id).join(',');
                     const resp = await fetch(`http://localhost:9999/api/fb/tasks-status?ids=${ids}`, {
                         headers: { 'X-Api-Secret': LOCAL_SERVER_SECRET }
                     });
                     const data = await resp.json();
                     if (data.success && data.tasks) {
                         setTasks(data.tasks);
                         const allDone = data.tasks.every((t: any) => t.status === 'success' || t.status === 'error');
                         if (allDone) setPolling(false);
                     }
                 } catch (err) {}
             }, 3000);
        }
        return () => clearInterval(timer);
    }, [polling, tasks]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setTasks([]);
        setPolling(false);
        const captchaKey = localStorage.getItem('captcha_solver_key') || '';

        try {
            const response = await fetch('http://localhost:9999/api/fb/batch-register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
                body: JSON.stringify({ 
                    count: selectedProfileIds ? selectedProfileIds.length : count, 
                    profileIds: selectedProfileIds,
                    captchaKey // 🚀 V5.5.2: 传递验证码 Key
                })
            });

            const data = await response.json();
            if (data.success) {
                setTasks(data.tasks || []);
                setPolling(true);
                if (onComplete) onComplete();
            } else {
                alert('启动 Facebook 注册任务失败: ' + (data.message || '未知错误'));
            }
        } catch (error) {
            alert('连接本地服务失败，请确保本地 Puppeteer 服务已启动');
        } finally { setIsSubmitting(false); }
    };

    return (
        <div className="max-w-full mx-auto">
            <div className="mb-4">
                <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                    {selectedProfileIds ? `FB 注册 ${selectedProfileIds.length} 个环境` : 'Facebook 批量注册'}
                    <span className="px-1.5 py-0.5 text-[8px] bg-blue-500/20 text-blue-400 rounded-full border border-blue-500/20 uppercase font-medium tracking-wider">V5.1.1</span>
                </h2>
                <p className="text-slate-400 text-xs">自动创建 Facebook 账号并完成邮箱验证流程。</p>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 shadow-inner">
                <form onSubmit={handleSubmit} className="space-y-4">
                    {!selectedProfileIds && (
                        <div className="space-y-2">
                            <label className="block text-xs font-medium text-slate-400">注册数量</label>
                            <div className="flex items-center gap-3">
                                <input type="range" min="1" max="10" value={count} onChange={(e) => setCount(parseInt(e.target.value))} className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                <div className="w-10 h-8 bg-slate-800 border border-slate-700 rounded flex items-center justify-center text-white font-mono text-sm font-bold">{count}</div>
                            </div>
                        </div>
                    )}
                    <button type="submit" disabled={isSubmitting} className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold rounded-lg transition-all shadow-lg flex items-center justify-center gap-2">
                        {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        {selectedProfileIds ? '立即执行 FB 注册' : '开始 FB 批量注册'}
                    </button>
                </form>
            </div>

            {tasks.length > 0 && (
                <div className="mt-6 space-y-3">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2 px-1">
                        <Facebook className="w-4 h-4 text-blue-400" />
                        任务进度 ({tasks.filter(t => t.status === 'success').length}/{tasks.length})
                    </h3>
                    <div className="grid gap-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                        {tasks.map((task, idx) => (
                            <div key={idx} className="bg-slate-950/50 border border-slate-800/50 rounded-lg p-3 flex items-center justify-between group">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-blue-400 text-xs font-bold border border-slate-700">{idx + 1}</div>
                                    <div className="min-w-0">
                                        <div className="text-xs font-medium text-white truncate max-w-[150px]">{task.profileName || `FB_Auto_${idx + 1}`}</div>
                                        <div className="text-[10px] text-slate-500 font-mono truncate max-w-[150px]">{task.email || '正在生成邮箱...'}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {task.status === 'success' ? <span className="text-[10px] text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">完成</span> : 
                                     task.status === 'error' ? <span className="text-[10px] text-rose-400 bg-rose-400/10 px-2 py-0.5 rounded-full">失败</span> : 
                                     <span className="text-[10px] text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded-full animate-pulse">执行中</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
