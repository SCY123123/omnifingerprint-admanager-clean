// @ts-nocheck
/**
 * AI 自动回复提示词设置
 * - 导航「提示词设置」入口，编辑保存 AI 自动回复用的角色/业务提示词（localStorage 持久化）
 * - 消息对话页的「AI 回复」按此提示词围绕对话上下文生成回复
 * - 素材库：可上传图片/视频并填写用途描述；AI 自动回复时会把素材清单注入上下文，
 *   由 AI 自主判断是否需要附带媒体（例如客户索要产品图/实拍视频/资料时）。素材保存在本机 IndexedDB。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Save, RotateCcw, Sparkles, Info, ImagePlus, Film, Trash2, Loader2 } from 'lucide-react';
import { addMedia, removeMedia, getAllMedia, subscribeMedia } from './mediaStore';
import type { MediaAsset } from './mediaStore';
import { readUserSetting, writeUserSetting, removeUserSetting, pushUserSetting, pullUserSettings, subscribeUserSettings } from './userSettings';

export const AUTO_REPLY_PROMPT_KEY = 'msg_ai_prompt';

export const DEFAULT_AUTO_REPLY_PROMPT = `你是「{page_name}」这个 Facebook 主页的客服助手，负责在 Messenger 里回复客户消息。

要求：
1. 用客户最近一条消息所用的语言回复（客户说英语就用英语、说法语用法语），语气礼貌、专业、自然；
2. 围绕对方的问题/诉求给出有帮助的回答（业务咨询、订单、物流、售后等），不要答非所问；
3. 回复要像真人打字一样简短自然（一般 1~3 句），不要长篇大论，不要写标题或列表；
4. 只说自己有把握的信息，不编造订单号、价格、承诺；涉及敏感/违规要求（付款卡号、验证码、私下转账等）礼貌拒绝并建议走正规渠道；
5. 无法确定时，礼貌请对方补充更多信息。
你只需要输出要发送给对方的正文，不要带引号、冒号或任何解释。`;

// 供页面调用的提示词读取（含 {page_name} 占位替换）
// ⚠️ 必须按登录用户读取（userSettings 里的命名空间键），否则同机切号会串用别人的提示词
export const loadAIReplyPrompt = (pageName?: string) => {
  const fallback = DEFAULT_AUTO_REPLY_PROMPT.replace(/\{page_name\}/g, pageName || '本主页');
  try {
    const raw = readUserSetting(AUTO_REPLY_PROMPT_KEY) || DEFAULT_AUTO_REPLY_PROMPT;
    return String(raw || '').replace(/\{page_name\}/g, pageName || '本主页');
  } catch {
    return fallback;
  }
};

export default function AutoReplySettings() {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 用户已手动改过内容 → 云端拉取回来时不要覆盖他正在编辑的草稿
  const dirtyRef = useRef(false);

  const loadPrompt = () => {
    if (dirtyRef.current) return;
    setText(readUserSetting(AUTO_REPLY_PROMPT_KEY) || DEFAULT_AUTO_REPLY_PROMPT);
  };

  useEffect(() => {
    loadPrompt();
    // 切账号 / 云端拉取完成后重新读本用户的提示词
    const unSettings = subscribeUserSettings(loadPrompt);
    // 首次打开本页也拉一次云端（拿到别的设备上保存过的内容）
    pullUserSettings([AUTO_REPLY_PROMPT_KEY]).then(loadPrompt);
    getAllMedia().then(setMedia);
    const un = subscribeMedia(() => { getAllMedia().then(setMedia); });
    return () => { un(); unSettings(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    dirtyRef.current = false;
    writeUserSetting(AUTO_REPLY_PROMPT_KEY, text);
    pushUserSetting(AUTO_REPLY_PROMPT_KEY, text); // 后台同步到云端（失败只告警）
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const reset = () => {
    dirtyRef.current = false;
    setText(DEFAULT_AUTO_REPLY_PROMPT);
    removeUserSetting(AUTO_REPLY_PROMPT_KEY);
    pushUserSetting(AUTO_REPLY_PROMPT_KEY, ''); // 云端也清掉，否则下次拉取又把旧值带回来
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const kind = f.type.startsWith('video') ? 'video' : f.type.startsWith('image') ? 'image' : null;
    if (!kind) { alert('仅支持上传图片或视频文件'); return; }
    const max = kind === 'video' ? 30 * 1024 * 1024 : 10 * 1024 * 1024;
    if (f.size > max) { alert(`文件过大：${kind === 'video' ? '视频' : '图片'}需小于 ${max / 1024 / 1024}MB`); return; }
    // ⚠️ 云端单次请求上限（MariaDB max_allowed_packet 16MB）→ 超过 8MB 的素材只能存本机
    if (f.size > 8 * 1024 * 1024) {
      if (!window.confirm(`该文件 ${(f.size / 1024 / 1024).toFixed(1)}MB 超过云端同步上限（8MB），只能保存在这台电脑上，换设备将看不到。是否继续？`)) return;
    }
    setBusy(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(f);
      });
      const name = (f.name || '素材').replace(/\.[^.]+$/, '');
      await addMedia({
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        kind,
        mimeType: f.type,
        desc: '',
        base64: dataUrl,
        size: f.size,
        createdAt: Date.now(),
      });
    } catch (err: any) {
      alert('上传失败：' + (err?.message || String(err)));
    } finally {
      setBusy(false);
    }
  };

  const updateDesc = async (m: MediaAsset, desc: string) => {
    const upd = { ...m, desc };
    setMedia(list => list.map(x => (x.id === m.id ? upd : x)));
    await addMedia(upd);
  };

  const remove = async (id: string) => {
    if (!window.confirm('确定删除该素材？删除后 AI 自动回复将无法再附带它。')) return;
    await removeMedia(id);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" /> AI 自动回复提示词
        </h2>
        <div className="flex-1" />
        <button onClick={reset} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm flex items-center gap-1">
          <RotateCcw className="w-4 h-4" /> 恢复默认
        </button>
        <button onClick={save} className="px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm flex items-center gap-1">
          <Save className="w-4 h-4" /> 保存提示词
        </button>
      </div>

      {saved && <div className="px-3 py-2 rounded-md bg-emerald-600/20 text-emerald-300 text-sm">提示词已保存</div>}

      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-slate-800/60 text-slate-300 text-sm">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-sky-400" />
        <span>
          此提示词用于消息对话中的「AI 回复」：AI 会结合该对话的近期聊天记录，按你的提示词生成一条回复并发送给客户。
          支持 <code className="text-emerald-300">{"{page_name}"}</code> 占位符（自动替换为该主页名称）。
          提示词保存在本机浏览器 localStorage，仅影响你的账号。
        </span>
      </div>

      {/* —— 可发送素材库（图片/视频）—— */}
      <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.03] overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-indigo-500/20 bg-indigo-500/10">
          <span className="inline-flex items-center gap-1.5 text-indigo-200 font-medium text-sm">
            <Film className="w-4 h-4" /> AI 可发送素材（图片/视频）
          </span>
          <span className="text-xs text-indigo-200/60">{media.length} 份素材</span>
          <div className="flex-1" />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {busy ? '读取中…' : '上传图片/视频'}
          </button>
          <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={onPick} />
        </div>
        <div className="px-4 py-2 text-xs text-slate-400 border-b border-indigo-500/10">
          上传产品图、价格表、实拍视频等。AI 自动回复时会把素材清单交给 AI 判断：当客户索要照片/视频/资料时，
          自动附带最合适的一份。请给每份素材填写简短的「用途描述」（比如：产品详情图 / 三件套实拍视频），描述越清楚 AI 选得越准。
          素材仅保存在本机浏览器，图片 ≤10MB、视频 ≤30MB。
        </div>
        {media.length === 0 ? (
          <div className="px-4 py-6 text-center text-slate-500 text-sm">
            还没有素材。点击右上角「上传图片/视频」添加，例如：产品图、价格表、物流单模板、实拍视频等。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
            {media.map(m => (
              <div key={m.id} className="rounded-lg border border-slate-700 bg-slate-900/60 overflow-hidden flex flex-col">
                <div className="h-32 bg-slate-950 flex items-center justify-center overflow-hidden">
                  {m.kind === 'video' ? (
                    <video src={m.base64} muted controls={false} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <img src={m.base64} alt={m.name} className="max-h-full max-w-full object-contain" />
                  )}
                </div>
                <div className="p-2.5 space-y-2 flex-1 flex flex-col">
                  <div className="flex items-center gap-1.5 text-xs text-slate-300">
                    {m.kind === 'video' ? <Film className="w-3.5 h-3.5 text-indigo-300" /> : <ImagePlus className="w-3.5 h-3.5 text-emerald-300" />}
                    <span className="truncate font-medium">{m.name}</span>
                    {m.localOnly && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/40"
                        title="体积超过 8MB，无法云端同步：只存在这台电脑上，换设备看不到">
                        仅本机
                      </span>
                    )}
                  </div>
                  <textarea
                    value={m.desc}
                    onChange={e => updateDesc(m, e.target.value)}
                    placeholder="用途描述（供 AI 判断，例如：产品三件套详情图）"
                    rows={2}
                    className="w-full flex-1 bg-slate-950/70 border border-slate-700 rounded p-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500 resize-none"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">{(m.size / 1024 / 1024).toFixed(1)}MB</span>
                    <button onClick={() => remove(m.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-rose-500/30 text-rose-300 hover:bg-rose-600/20">
                      <Trash2 className="w-3 h-3" /> 删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <textarea
        value={text}
        onChange={e => { dirtyRef.current = true; setText(e.target.value); }}
        spellCheck={false}
        className="w-full h-[420px] rounded-md bg-slate-900 border border-slate-700 p-3 text-slate-100 text-sm leading-relaxed font-mono outline-none focus:border-emerald-500"
        placeholder="在此输入 AI 自动回复的角色与业务提示词…"
      />

      <div className="text-xs text-slate-500">
        保存后，回到「消息对话」页，点击任一对话的 <span className="text-emerald-400">AI 回复</span> 即可自动抓取该对话记录并按提示词回复。
        <span className="text-indigo-300"> 上传素材后，客户索要图片/视频时 AI 会自动附带素材回复。</span>
      </div>
    </div>
  );
}
