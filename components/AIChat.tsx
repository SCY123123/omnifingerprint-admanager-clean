import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2, Play, X, Square, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// 🧵 AI 的慢操作（获取信息/拉贴文/启停浏览器）统一提交到服务端队列执行
import { submitJob, OP_LABELS, type SlowOpType } from './jobQueue';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: any[];
}

export const AIChat = () => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: '你好！我是 OmniFingerprint AI 助手。我可以帮你启动浏览器、查询配置或回答相关问题。' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false });
  const interruptRef = useRef(false);
  // 🚀 当前在飞的本机请求：点「停止」时要立刻 abort，否则 await 里的请求不会被打断
  const abortRef = useRef<AbortController | null>(null);
  // 🚀 工具执行进度（"2/10：get_info(3820)"）：单个 get_info 实测约 55s，没有进度就像卡死
  const [toolProgress, setToolProgress] = useState('');
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // 🚀 拖动
  const handleDragStart = (e: React.MouseEvent) => {
    dragState.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: dragOffset.x,
      originY: dragOffset.y,
      moved: false,
    };
    e.preventDefault();
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragState.current.dragging) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.current.moved = true;
      setDragOffset({
        x: dragState.current.originX + dx,
        y: dragState.current.originY + dy,
      });
    };
    const handleUp = () => {
      dragState.current.dragging = false;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const LOCAL_BASE = 'http://localhost:9999/api';
  const LOCAL_SECRET = (import.meta as any).env?.VITE_LOCAL_SERVER_SECRET || '';

  // 调用本机浏览器管理服务（启动/查询运行状态均走这里）
  // ⏱️ 必须带超时与可中断：/launch-browser 实测 30~70s、等并发空位还能再等 150s，
  //    /facebook/fetch-adaccounts-graph 一次也要 20~60s。原来是无超时裸 fetch，
  //    任何一次卡住就会永远停在「正在执行操作…」，连「停止」都按不动（只能刷页面）。
  const callLocalApi = async (path: string, options?: RequestInit, timeoutMs = 300000) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${LOCAL_BASE}${path}`, {
        ...options,
        signal: ctrl.signal,
        headers: {
          ...(options?.headers || {}),
          'X-Api-Secret': LOCAL_SECRET,
          ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      return await resp.json();
    } catch (e: any) {
      if (ctrl.signal.aborted) throw new Error(interruptRef.current ? '已中断' : `本机接口超时(${Math.round(timeoutMs / 1000)}s)：${path}`);
      throw e;
    } finally {
      clearTimeout(timer);
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  // 把 toolCalls 还原成 DeepSeek 需要的 OpenAI 格式，用于第二轮继续对话
  const toOpenAiToolCalls = (toolCalls: any[]) =>
    toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
    }));

  const chatOnce = async (convo: any[]) => {
    const authToken = localStorage.getItem('auth_token');
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ messages: convo }),
    });
    return response.json();
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsLoading(true);
    interruptRef.current = false;

    // 跳过上一轮因“停止”而未完成工具往返的悬挂 assistant 消息，避免把残缺 tool_calls 发给模型
    const history = messages
      .filter(m => m.role === 'user' || !(m.toolCalls && m.toolCalls.length))
      .map(m => ({ role: m.role, content: m.content }));
    const convo: any[] = [...history, { role: 'user', content: userMsg }];

    try {
      // 支持多轮工具调用：模型要求执行工具 → 本机执行 → 结果回传 → 模型给出最终回答
      for (let round = 0; round < 4; round++) {
        if (interruptRef.current) break;
        const data = await chatOnce(convo);
        if (interruptRef.current) break;

        if (!data || !data.success) {
          if (round === 0 && !interruptRef.current) {
            setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${(data && data.error) || '无法获取 AI 响应'}` }]);
          }
          break;
        }

        const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
        let replyText = data.message || (toolCalls.length ? '正在执行操作…' : '');
        // ⚠️ 这些工具会真实占用本机浏览器（一次只跑有限个），且是串行执行。
        //    模型拿到配置编号列表后可能一次吐出几十上百个调用，界面只显示转圈会让人以为卡死 → 提前告知耗时。
        const SLOW_TOOLS = ['get_info', 'fetch_posts', 'publish_ad', 'browse_ads_library', 'launch_browser'];
        const slowCount = toolCalls.filter((tc: any) => SLOW_TOOLS.includes(String(tc && tc.name || ''))).length;
        if (slowCount >= 3) {
          replyText += `\n\n⚠️ 本次要真实执行 ${toolCalls.length} 个操作（其中 ${slowCount} 个会启动/复用本机浏览器，每个约 30~60 秒，串行执行，预计 ${Math.max(1, Math.ceil(slowCount * 55 / 60))} 分钟以上）。可随时点下方的「停止」按钮中断。`;
        }
        setMessages(prev => [...prev, { role: 'assistant', content: replyText, reasoning: data.reasoning, toolCalls }]);
        convo.push({
          role: 'assistant',
          content: toolCalls.length ? null : replyText,
          tool_calls: toolCalls.length ? toOpenAiToolCalls(toolCalls) : undefined,
        });

        if (!toolCalls.length) break; // 纯文本回答，本轮结束

        // 🧵 慢操作（会真实占用本机浏览器）统一提交到服务端队列：
        //    - 同类工具合并成一个任务，避免一次对话产生几十个独立任务
        //    - 提交后立刻返回，真正的执行/进度/取消都在后端，前端刷新也不会中断
        const SLOW_OP: Record<string, SlowOpType> = {
          get_info: 'get_info',
          fetch_posts: 'fetch_posts',
          launch_browser: 'launch_browser',
          stop_browser: 'stop_browser',
        };
        const groups: Record<string, Array<{ key: string; label?: string; payload: any }>> = {};
        for (const tc of toolCalls) {
          const nm = String(tc.name || '');
          const op = SLOW_OP[nm];
          if (!op) continue;
          const pid = String((tc.arguments || {}).profileId || '');
          if (!pid) continue;
          (groups[op] = groups[op] || []).push({ key: pid, label: pid, payload: { profileId: pid } });
        }
        const jobIdByOp: Record<string, string> = {};
        for (const op of Object.keys(groups)) {
          try {
            const job = await submitJob({ type: op as SlowOpType, title: `AI：${OP_LABELS[op] || op}（${groups[op].length} 个配置）`, items: groups[op] });
            jobIdByOp[op] = job.id;
          } catch (e: any) {
            jobIdByOp[op] = '';
            // 后端不可达：下面逐个工具会如实反馈失败
            console.warn('提交执行队列失败:', e?.message || e);
          }
        }
        if (Object.keys(jobIdByOp).length) {
          setToolProgress(`已提交到执行队列：${Object.keys(groups).map((op) => `${OP_LABELS[op] || op} ${groups[op].length} 个`).join('、')}`);
        }

        // 逐个处理工具：慢操作已入队（只回执任务号），其余在本机直接执行
        const executed: { id?: string; text: string }[] = [];
        for (let ti = 0; ti < toolCalls.length; ti++) {
          if (interruptRef.current) break;
          const tool = toolCalls[ti];
          const toolName = String(tool.name || '');
          const tArgs = (tool.arguments && typeof tool.arguments === 'object') ? tool.arguments : {};
          // 🧵 已入队的慢操作：不再本地阻塞执行
          const queuedOp = SLOW_OP[toolName];
          if (queuedOp && tArgs.profileId) {
            const jobId = jobIdByOp[queuedOp];
            executed.push({
              id: tool.id,
              text: jobId
                ? `配置 ${tArgs.profileId} 的「${OP_LABELS[queuedOp] || queuedOp}」已加入执行队列（任务 ${jobId}），由本机后端排队执行；进度和取消请看左侧菜单「执行队列」。`
                : `配置 ${tArgs.profileId} 的「${OP_LABELS[queuedOp] || queuedOp}」入队失败：本机队列服务（localhost:9999）不可达。`,
            });
            continue;
          }
          // 🚀 进度提示：批量工具是串行真实执行（每个 get_info ≈ 55s），必须让用户看到进行到哪了
          setToolProgress(`${ti + 1}/${toolCalls.length}：${toolName}${tArgs.profileId ? `(${tArgs.profileId})` : ''}`);
          if (toolName === 'manage_campaigns' || toolName === 'manage_adsets' || toolName === 'manage_ads') {
            const kind = toolName.replace('manage_', ''); // campaigns / adsets / ads
            const pid = String(tArgs.profileId || '');
            const assetId = String(tArgs.assetId || '');
            const action = String(tArgs.action || '');
            if (!pid || !assetId || !action) {
              executed.push({ id: tool.id, text: `${toolName} 缺少参数（需要 profileId、assetId、action）。` });
              continue;
            }
            const actionLabel = action === 'start' ? '启动' : (action === 'stop' ? '停止' : '归档');
            try {
              const json = await callLocalApi(`/facebook/adaccounts/${kind}/manage`, { method: 'POST', body: JSON.stringify({ profileId: pid, assetId, action }) });
              executed.push({ id: tool.id, text: json && json.success ? `广告${kind} ${assetId} 已${actionLabel}（配置 ${pid}）。` : `广告${kind} ${assetId} ${actionLabel}失败：${(json && json.message) || '未知错误'}` });
            } catch (e: any) {
              executed.push({ id: tool.id, text: `调用本机广告管理接口失败：${e.message || e}` });
            }
          } else if (toolName === 'publish_ad' && tArgs.profileId && tArgs.templateId) {
            const pid = String(tArgs.profileId);
            const tid = String(tArgs.templateId);
            try {
              // 读取模板内容（文案/素材/落地页在模板 config 中），再调用本机批量发布接口
              const authToken = localStorage.getItem('auth_token');
              const tplResp = await fetch('/api/ad-templates', { headers: { 'Authorization': `Bearer ${authToken}` } });
              const tplJson = await tplResp.json();
              const tpl = Array.isArray(tplJson.data) ? tplJson.data.find((t: any) => String(t.id) === tid) : null;
              if (!tpl) {
                executed.push({ id: tool.id, text: `未找到广告模板（id=${tid}），请先到“广告模板”页用一键智能发布保存模板后再试。` });
              } else {
                let config: any = tpl.config;
                if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = {}; } }
                if (!config || typeof config !== 'object') config = {};
                const tree = Array.isArray(config.campaignTree) ? config.campaignTree : [];
                if (!tree.length) {
                  executed.push({ id: tool.id, text: `模板「${tpl.name || tid}」没有可发布的广告内容（campaignTree 为空），请先在模板中保存完整广告配置。` });
                } else {
                  const json = await callLocalApi('/facebook/batch-publish', {
                    method: 'POST',
                    body: JSON.stringify({
                      profileId: pid,
                      campaignTree: tree,
                      publishMethod: config.publishMethod || 'api',
                      launchBrowser: config.launchBrowser !== false,
                      campaignCount: config.campaignCount || 1,
                      adSetCount: config.adSetCount || 1,
                      adCount: config.adCount || 1,
                    }),
                  });
                  executed.push({ id: tool.id, text: json && json.success
                    ? `模板「${tpl.name || tid}」已在配置 ${pid} 发布完成：成功 ${json.successCount || 0}/${json.total || 0}。`
                    : `配置 ${pid} 使用模板「${tpl.name || tid}」发布失败：${(json && (json.message || json.error)) || '未知错误'}` });
                }
              }
            } catch (e: any) {
              executed.push({ id: tool.id, text: `调用模板/发布接口失败：${e.message || e}` });
            }
          } else if (toolName === 'fetch_posts' && !tArgs.profileId) {
            // 未指明配置：让模型先问清楚（带 profileId 的情况已在上面批量入队）
            executed.push({ id: tool.id, text: '拉取贴文/对话需要指定配置：请先调用 list_profiles 查询可用配置列表，问清用户要拉取哪个配置后，再调用 fetch_posts(profileId=配置编号)。' });
          } else if (toolName === 'browse_ads_library' && tArgs.profileId) {
            const pid = String(tArgs.profileId);
            try {
              const body: any = { profileId: pid };
              if (tArgs.q) body.q = String(tArgs.q);
              if (tArgs.country) body.country = String(tArgs.country);
              if (tArgs.url) body.url = String(tArgs.url);
              const json = await callLocalApi('/facebook/browse', { method: 'POST', body: JSON.stringify(body) });
              if (json && json.success) {
                const links = Array.isArray(json.links) ? json.links : [];
                const snippet = String(json.textSample || '').replace(/\s+/g, ' ').slice(0, 1200);
                executed.push({ id: tool.id, text: `已打开：${json.title || json.url || '广告图书馆'}（链接 ${links.length} 条）。${snippet ? `页面内容：${snippet}` : '页面暂无可读文本（可能未加载完/需要登录），可看弹出浏览器窗口。'}` });
              } else {
                executed.push({ id: tool.id, text: `配置 ${pid} 打开页面失败：${(json && (json.message || json.error)) || '未知错误'}` });
              }
            } catch (e: any) {
              executed.push({ id: tool.id, text: `配置 ${pid} 浏览操作异常：${e.message || e}` });
            }
          } else if (toolName === 'list_running_browsers') {
            try {
              const json = await callLocalApi('/browsers');
              const list = Array.isArray(json.data) ? json.data : [];
              const ids = list.map((b: any) => b.profileId).filter(Boolean);
              executed.push({ id: tool.id, text: json && json.success ? `本机当前正在运行的浏览器共 ${ids.length} 个，配置编号：${ids.length ? ids.join('、') : '无'}。` : `查询运行状态失败：${(json && json.message) || '未知错误'}` });
            } catch (e: any) {
              executed.push({ id: tool.id, text: `调用本机查询接口失败：${e.message || e}` });
            }
          } else {
            executed.push({ id: tool.id, text: `未知工具：${tool.name}` });
          }
        }
        toolCalls.forEach(tc => {
          const r = executed.find(x => x.id === tc.id);
          convo.push({ role: 'tool', tool_call_id: tc.id, content: r ? r.text : '执行失败' });
        });
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: '网络错误，请稍后再试。' }]);
    } finally {
      interruptRef.current = false;
      setToolProgress('');
      setIsLoading(false);
    }
  };

  // 停止当前执行：在下一步开始前停下，随后即可发送新消息
  const handleStop = () => {
    interruptRef.current = true;
    // 🚀 关键：立即 abort 正在飞的本机请求。原来只置标记，await 里的 fetch 不会被打断，
    //    用户点了「停止」界面还是没反应（要等那个请求自己返回，最长 5 分钟）
    try { abortRef.current?.abort(); } catch {}
    setIsLoading(false);
    setToolProgress('');
    setMessages(prev => [...prev, { role: 'assistant', content: '已中断当前操作，你可以继续发送新指令。' }]);
  };

  return (
    <div ref={containerRef} className={`fixed bottom-6 right-6 z-50 flex flex-col transition-all duration-300 ${isOpen ? 'w-96 h-[600px]' : 'w-14 h-14'}`} style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}>
      {!isOpen ? (
        <button
          onClick={() => { if (!dragState.current.moved) setIsOpen(true); }}
          onMouseDown={handleDragStart}
          className="w-14 h-14 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-2xl hover:bg-indigo-500 transition-colors cursor-grab active:cursor-grabbing"
        >
          <MessageSquare className="w-6 h-6" />
        </button>
      ) : (
        <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="p-4 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Omni AI</h3>
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                  <span className="text-[10px] text-slate-400">DeepSeek Reasoner</span>
                </div>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white p-1">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/50">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {m.reasoning && (
                    <details className="w-full mb-1">
                      <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400 list-none flex items-center gap-1">
                        <ChevronDown className="w-3 h-3" /> 思考过程
                      </summary>
                      <div className="mt-1 p-2 bg-slate-800/50 rounded text-[11px] text-slate-400 font-mono italic whitespace-pre-wrap border-l-2 border-indigo-500/30">
                        {m.reasoning}
                      </div>
                    </details>
                  )}
                  <div className={`px-4 py-2 rounded-2xl text-sm ${
                    m.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'
                  }`}>
                    {m.content}
                  </div>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-slate-800 text-slate-200 px-4 py-2 rounded-2xl rounded-tl-none border border-slate-700 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  {toolProgress && <span className="text-xs text-slate-300">正在执行 {toolProgress}（点下方方块可停止）</span>}
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-4 bg-slate-900 border-t border-slate-800">
            <div className="relative">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="输入指令，例如：启动配置 386 / 当前运行了几个浏览器？"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-4 pr-12 py-3 text-sm text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none placeholder:text-slate-600"
              />
              <button
                onClick={isLoading ? handleStop : handleSend}
                disabled={!isLoading && !input.trim()}
                title={isLoading ? '停止当前操作' : '发送'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-white rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent bg-indigo-600 hover:bg-indigo-500 disabled:hover:bg-indigo-600"
              >
                {isLoading ? <Square className="w-4 h-4 fill-current" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
