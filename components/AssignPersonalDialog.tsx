import React, { useState, useEffect, useMemo } from 'react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl, selectionKeyOf } from '../utils/constants';
import { SearchSelect, SearchOption } from './SearchSelect';
import { submitJob, waitForJob } from './jobQueue';
import type { AdAccountRow, PageRow, FingerprintProfile } from '../types';

interface AssignPersonalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'adAccount' | 'page';
  sortedData: (AdAccountRow | PageRow)[];
  selectedIds: Set<string>;
  uniqueIdKey: string;
  onRefresh: () => void;
  /** 系统里的配置列表：用于「从系统配置选个人号」，自动读出它自己的 FB 用户 ID */
  profiles?: FingerprintProfile[];
}

/** 广告号授权档位：值传给后端，数字 role ID 由后端映射（抓包实测 281423141961500=管理员 等） */
type AdAccountGrantRole = 'ADMIN' | 'ADVERTISER' | 'ANALYST';

const AD_ROLE_OPTIONS: { value: AdAccountGrantRole; label: string; desc: string }[] = [
  { value: 'ADMIN', label: '管理员', desc: '可管理广告、账单、支付方式和人员权限' },
  { value: 'ADVERTISER', label: '普通权限', desc: '可创建和编辑广告、查看报表、使用现有支付方式' },
  { value: 'ANALYST', label: '分析师', desc: '仅可查看广告表现和报表' }
];

export const AssignPersonalDialog: React.FC<AssignPersonalDialogProps> = ({
  isOpen, onClose, mode, sortedData, selectedIds, uniqueIdKey, onRefresh, profiles = []
}) => {
  // 🆕 个人号来源：从系统配置选（自动解析 FB ID） / 手填 FB 用户 ID
  const [source, setSource] = useState<'profile' | 'manual'>('profile');
  const [personalProfileId, setPersonalProfileId] = useState('');
  const [resolvedFbUserId, setResolvedFbUserId] = useState('');
  // 解析来源（配置 Cookie / 云端 Cookie / Graph me?id）——只影响提示文案，让人知道 ID 从哪来的
  const [resolveSource, setResolveSource] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [addFriend, setAddFriend] = useState(false);
  // 🆕 授权档位：默认管理员。对应的 role ID 是从 4340 在 Ads Manager 里手动授权一次抓包实测出来的，
  //    三个档位各试了一遍，一一对应。
  const [role, setRole] = useState<AdAccountGrantRole>('ADMIN');
  const [fbUserIdInput, setFbUserIdInput] = useState('');
  const [assetIdsInput, setAssetIdsInput] = useState('');
  const [creating, setCreating] = useState(false);
  // 🧵 交给服务端队列后，弹窗只显示「第几批 / 共几批」，真正的进度在左侧「执行队列」里
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');

  const lurl = getLaunchServerUrl();
  const canAddFriend = mode === 'adAccount';

  // 系统配置 → 可搜索下拉选项（ID / 名称 / 账号邮箱都能搜）
  const profileOptions = useMemo<SearchOption[]>(() => profiles.map(p => {
    const anyP = p as any;
    const name = String(p.name || '');
    const email = String(anyP.accountEmail || anyP.account || '');
    return {
      value: String(p.id),
      label: name ? `${p.id} · ${name}` : String(p.id),
      sub: email || undefined,
      keywords: `${p.id} ${name} ${email}`
    };
  }), [profiles]);

  // 🧮 当前列表里「真正勾选到的资产」：selectedIds 里可能残留别的列表/已被筛选隐藏的键，
  //    所以逐行核对本列表，而不是直接读 selectedIds.size（否则会显示「已选 2 个」却一个也匹配不到）。
  const selectedAssets = useMemo(() => {
    const map = new Map<string, any>();
    for (const item of sortedData as any[]) {
      if (!selectedIds.has(selectionKeyOf(item, uniqueIdKey))) continue;
      const id = String(item?.[uniqueIdKey] ?? '');
      if (id && !map.has(id)) map.set(id, item);
    }
    return map;
  }, [sortedData, selectedIds, uniqueIdKey]);

  // Reset state when the dialog opens
  useEffect(() => {
    if (isOpen) {
      setSource('profile');
      setPersonalProfileId('');
      setResolvedFbUserId('');
      setResolveError('');
      setAddFriend(false);
      setRole('ADMIN');
      setFbUserIdInput('');
      setAssetIdsInput('');
      setProgress(null);
      setError('');
    }
  }, [isOpen]);

  // 选中配置后，让本地服务从该配置的登录 Cookie 里读出 c_user（它自己的 FB 用户 ID）
  useEffect(() => {
    if (!isOpen || source !== 'profile' || !personalProfileId) {
      setResolvedFbUserId(''); setResolveSource(''); setResolveError(''); setResolving(false); return;
    }
    let cancelled = false;
    // ⚠️ 必须带超时：这一步是「选配置后自动解析」，如果请求因为本地后端刚重启/连接失效而挂住，
    //    没有超时的话 resolving 会永远是 true → 提交按钮被永久锁死，用户完全无从下手。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    (async () => {
      setResolving(true); setResolveError('');
      try {
        const resp = await fetch(`${lurl}/api/facebook/profile-fb-id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({ profileId: personalProfileId }),
          signal: ctrl.signal
        });
        const json = await resp.json();
        if (cancelled) return;
        if (json?.success && json.userId) { setResolvedFbUserId(String(json.userId)); setResolveSource(String(json.source || '')); }
        else { setResolvedFbUserId(''); setResolveSource(''); setResolveError(json?.message || '解析失败'); }
      } catch (e) {
        if (!cancelled) {
          setResolvedFbUserId('');
          setResolveSource('');
          setResolveError((e as Error)?.name === 'AbortError'
            ? '解析超时（本机后端可能刚重启过）。刷新页面后重试，或切到「手填 FB 用户 ID」'
            : `解析失败: ${(e as Error).message}`);
        }
      } finally {
        clearTimeout(timer);
        if (!cancelled) setResolving(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); ctrl.abort(); };
  }, [isOpen, source, personalProfileId, lurl]);

  const handleAssign = async () => {
    if (source === 'profile' && !personalProfileId) { setError('请选择作为个人号的系统配置'); return; }
    const targetFbUserId = source === 'profile' ? resolvedFbUserId : fbUserIdInput.trim();
    if (!targetFbUserId) {
      setError(source === 'profile'
        ? (resolveError || (resolving ? '正在解析该配置的 FB 用户 ID，请等解析完再点' : '该配置的 FB 用户 ID 还没解析出来'))
        : '请输入 FB 用户 ID');
      return;
    }

    // 🎯 执行身份：每个资产只用「一行」对应的配置 —— 优先用户勾选的那行。
    //    ⚠️ 以前的写法是先抽出资产 ID，再回头遍历整个列表，把所有同 ID 的行都当成执行者：
    //    同一个主页会出现在多个配置下（多个账号都是它的管理员），于是勾选一行也会用
    //    所有关联账号各发一次邀请，日志里一堆配置在授权同一个主页，看不出谁在执行。
    const entityName = mode === 'adAccount' ? '广告号' : '主页';
    let ownerRows: any[] = [];
    let unmatched: string[] = [];
    const firstRowByAsset = new Map<string, any>();
    if (assetIdsInput.trim()) {
      const wanted = assetIdsInput.split(/[,;\s]+/).map(s => s.replace(/^act_/, '').trim()).filter(Boolean);
      // 手填 ID 无法指定归属配置：按列表顺序，每个资产取第一行作为执行身份
      for (const item of sortedData) {
        const id = String((item as any)[uniqueIdKey] || '');
        if (id && wanted.includes(id) && !firstRowByAsset.has(id)) firstRowByAsset.set(id, item);
      }
      unmatched = wanted.filter(w => !firstRowByAsset.has(w));
      if (firstRowByAsset.size === 0) {
        setError(`输入的 ${wanted.length} 个 ID 在当前${entityName}列表里找不到对应行，无法确定执行身份。请先在列表里勾选这些${entityName}，或从列表里复制正确的 ${uniqueIdKey}。`);
        return;
      }
    } else {
      // ⚠️ selectedIds 存的是「配置ID::资产ID」复合键，直接当资产ID 提交是错的；
      //    这里从选中行取真实资产ID（同一资产在多配置下会重复出现 → 只留第一行）
      for (const [id, item] of selectedAssets) firstRowByAsset.set(id, item);
      if (firstRowByAsset.size === 0) {
        setError(`没有勾选任何${entityName}（当前列表筛选/搜索后共 ${sortedData.length} 行）。请先在上面的列表里勾选，或在这里填 ${entityName} ID。`);
        return;
      }
    }
    const assetIds = Array.from(firstRowByAsset.keys());
    ownerRows = Array.from(firstRowByAsset.values());
    const unmatchedNote = unmatched.length ? `\n（有 ${unmatched.length} 个 ID 不在当前列表里，已跳过：${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ' …' : ''}）` : '';
    if (assetIds.length === 0 || ownerRows.length === 0) { setError('没有可授权的资产'); return; }

    try {
      setCreating(true);
      setError('');
      setProgress(null);

      // 按「资产所属配置」分组 → 一个配置 = 一个队列 item（配置之间可并发执行）。
      // ⚠️ 只遍历 ownerRows（每个资产只保留一行的执行身份），不再遍历整个列表 ——
      //    否则同一个主页会被它名下所有配置各授权一次。
      const byProfile = new Map<string, string[]>();
      for (const item of ownerRows) {
        const id = String((item as any)[uniqueIdKey] || '');
        const pid = String((item as any).profileId || (item as any).profile_id || '');
        if (!id || !pid) continue;
        if (!byProfile.has(pid)) byProfile.set(pid, []);
        byProfile.get(pid)!.push(id);
      }
      if (byProfile.size === 0) {
        setError('无法确定这些资产属于哪个配置（请从列表勾选，或确认输入的资产 ID 在当前列表里）');
        return;
      }

      // 广告号 + 从配置选 → 完整版（后端从 Cookie 解析个人号 FB ID，支持同时加好友）
      const useFullFlow = mode === 'adAccount' && source === 'profile';
      const items = Array.from(byProfile).map(([pid, ids]) => ({
        key: `${pid}::${ids.length}`,
        label: `执行身份 配置 ${pid}（${ids.length} 个${mode === 'adAccount' ? '广告号' : '主页'}）`,
        payload: {
          mode,
          ownerProfileId: pid,
          personalProfileId: useFullFlow ? personalProfileId : undefined,
          fbUserId: useFullFlow ? undefined : targetFbUserId,
          assetIds: ids,
          addFriend: canAddFriend && addFriend,
          role
        }
      }));

      const job = await submitJob({
        type: 'grant_personal',
        title: `${mode === 'adAccount' ? '授权广告号' : '授权主页'}到个人号（${assetIds.length} 个资产）`,
        items
      });
      // 提交完就能随便刷新/关页面，任务在后端照跑；这里只是等结果好回显给用户
      setProgress({ done: 0, total: items.length });
      const finished = await waitForJob(job.id, (j) => {
        if (j) setProgress({ done: j.done + j.fail, total: j.total });
      });

      const ok = finished?.ok ?? 0;
      const lines = (finished?.items || [])
        .map(it => `  ${it.status === 'done' ? '✅' : '⚠️'} ${it.label}: ${it.message}`)
        .join('\n');
      const failedCount = (finished?.items || []).filter(it => it.status !== 'done').length;

      // 🎯 主页模式：邀请发出去后，让「受邀方配置」的浏览器自动去同意。
      //    走 FB 内部 GraphQL（先打开那个主页的邀请页取 profile_admin_invite_id，再发 mutation），
      //    不依赖界面语言/选择器。⚠️ 邀请到对方那边有延迟，先等几秒再让浏览器去找邀请页。
      let acceptBlock = '';
      if (mode === 'page' && source === 'profile' && personalProfileId) {
        if (ok <= 0) {
          // 邀请一个都没发出去，就没有邀请可同意 —— 直接跳过，免得白开一次浏览器
          acceptBlock = '\n\n（授权无一成功，已跳过「对方自动同意」）';
        } else {
          await new Promise(r => setTimeout(r, 5000));
          const acceptJob = await submitJob({
            type: 'accept_page_invite',
            title: `同意主页邀请（${assetIds.length} 个）`,
            items: [{
              key: String(personalProfileId),
              label: `配置 ${personalProfileId}（${assetIds.length} 个主页）`,
              payload: { profileId: personalProfileId, pageIds: assetIds }
            }]
          });
          const acceptFinished = await waitForJob(acceptJob.id, (j) => {
            if (j) setProgress({ done: j.done + j.fail, total: j.total });
          });
          const acceptLines = (acceptFinished?.items || [])
            .map(it => `  ${it.status === 'done' ? '✅' : '⚠️'} ${it.message}`)
            .join('\n');
          if (acceptLines) acceptBlock = `\n\n对方浏览器自动同意:\n${acceptLines}`;
        }
      }

      // 🧾 把「谁在执行、授权给谁」讲清楚：以前只报成功批数，从结果里看不出执行身份，
      //    多个配置的批次并排出现时很容易误以为所有关联账号都在授权。
      const identityLine = mode === 'page'
        ? `执行身份: 各资产所属配置（再切到该主页身份发邀请）\n授权对象: 个人号 FB ${targetFbUserId}`
        : `执行身份: 各广告号所属配置\n授权对象: 个人号 FB ${targetFbUserId}`;

      if (failedCount === 0) {
        alert(`授权成功: ${ok} 批资产已授权给个人号\n${identityLine}${unmatchedNote}\n\n${lines}${acceptBlock}`);
        onClose();
      } else {
        alert(`授权完成: 成功 ${ok} 批, 失败 ${failedCount} 批\n${identityLine}${unmatchedNote}\n\n${lines}${acceptBlock}\n\n（已提交到执行队列，可在左侧「执行队列」查看/取消）`);
      }
      onRefresh();
    } catch (e) {
      setError(`提交执行队列失败: ${(e as Error).message}（请确认本机后端 9999 已启动）`);
    }
    finally { setCreating(false); }
  };

  if (!isOpen) return null;

  // ⚠️ 只要选中了配置就算「可提交」：FB 用户 ID 是自动解析出来的，解析没回来/失败时
  //    不应该把按钮永久锁死 —— 否则用户连「为什么点不了」的提示都看不到。
  //    真没解析出来时点提交会明确告诉他原因。
  const ready = source === 'profile' ? !!personalProfileId : !!fbUserIdInput.trim();

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">
          {mode === 'adAccount' ? '广告号授权到个人号' : '主页授权到个人号'}
        </h3>
        <div className="space-y-3">
          {/* 🆕 个人号来源 */}
          <div>
            <label className="block text-sm text-slate-300 mb-1">个人号来源</label>
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => setSource('profile')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs border ${source === 'profile' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300'}`}>
                从系统配置选
              </button>
              <button type="button" onClick={() => setSource('manual')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs border ${source === 'manual' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300'}`}>
                手填 FB 用户 ID
              </button>
            </div>

            {source === 'profile' ? (
              <div className="space-y-2">
                <SearchSelect
                  value={personalProfileId}
                  onChange={setPersonalProfileId}
                  options={profileOptions}
                  placeholder="-- 搜索并选择作为个人号的配置 --"
                  searchPlaceholder="输入配置 ID、名称或账号邮箱搜索"
                  emptyText="没有取到系统配置列表，请刷新页面重试"
                />
                {resolving && <p className="text-xs text-slate-500">正在解析该配置的 FB 用户 ID…（不在本地库的配置要从云端取，最长约 10 秒）</p>}
                {!resolving && resolvedFbUserId && (
                  <p className="text-xs text-emerald-400 font-mono">FB 用户 ID: {resolvedFbUserId}{resolveSource ? `（来源: ${resolveSource}）` : ''}</p>
                )}
                {!resolving && resolveError && <p className="text-xs text-rose-400">{resolveError}</p>}
              </div>
            ) : (
              <div>
                <input
                  value={fbUserIdInput}
                  onChange={e => setFbUserIdInput(e.target.value)}
                  placeholder="对方个人 Facebook 用户 ID (数字)"
                  className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono"
                />
                <p className="text-xs text-slate-500 mt-1">必须是数字格式的 FB 用户 ID(不是邮箱)。</p>
              </div>
            )}
          </div>

          {/* 🆕 授权档位（仅广告号） */}
          {mode === 'adAccount' && (
            <div>
              <label className="block text-sm text-slate-300 mb-1">授权档位</label>
              <div className="flex gap-2">
                {AD_ROLE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRole(opt.value)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-xs border ${role === opt.value ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {AD_ROLE_OPTIONS.find(o => o.value === role)?.desc}
              </p>
            </div>
          )}

          {/* 🆕 双向加好友（仅广告号、且从配置选时可用） */}
          {canAddFriend && source === 'profile' && (
            <label className="flex items-start gap-2 p-3 bg-slate-950 border border-slate-700 rounded-lg cursor-pointer">
              <input type="checkbox" checked={addFriend} onChange={e => setAddFriend(e.target.checked)}
                className="mt-0.5 rounded border-slate-700 bg-slate-800 text-indigo-600" />
              <span className="text-xs text-slate-300">
                同时双向加好友
                <span className="block text-slate-500 mt-0.5">
                  先由「选中配置」向「广告号所属配置」发好友请求，再由对方自动点同意 —— 好友关系本身就是双向的，这样就互为好友，然后继续授权管理员。加好友/同意都走从真实点击抓包得到的 FB 内部 GraphQL（Meta 已下线公开好友接口），不依赖页面渲染和界面语言；FB 改版换了 doc_id 时会自动回退到界面点击。失败不影响授权。
                </span>
              </span>
            </label>
          )}

          <div>
            <label className="block text-sm text-slate-300 mb-1">
              {mode === 'adAccount' ? '广告号 ID (可选)' : '主页 ID (可选)'}
            </label>
            <input
              value={assetIdsInput}
              onChange={e => setAssetIdsInput(e.target.value)}
              placeholder={mode === 'adAccount'
                ? `留空使用选中的 ${selectedAssets.size} 个广告号,或输入 act_xxx,xxx`
                : `留空使用选中的 ${selectedAssets.size} 个主页,或输入 page_id_1,page_id_2`
              }
              className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono"
            />
            <p className="text-xs text-slate-500 mt-1">留空将使用当前列表勾选的资产,多个用逗号分隔。</p>
            {selectedAssets.size === 0 && !assetIdsInput.trim() && (
              <p className="text-xs text-amber-400 mt-1">
                当前列表里没有勾选任何{mode === 'adAccount' ? '广告号' : '主页'}，也没有填 ID —— 直接点下面的按钮会报「没有可授权的资产」，请先回到列表勾选，或在这里填 ID。
              </p>
            )}
          </div>
          <div className="p-3 bg-indigo-900/20 border border-indigo-800/50 rounded-lg">
            <p className="text-xs text-indigo-300">
              {mode === 'adAccount'
                ? `权限:按上面选的档位授予（当前:${AD_ROLE_OPTIONS.find(o => o.value === role)?.label}）`
                : '权限:固定全权限 (MANAGE + CREATE_CONTENT + MODERATE + ADVERTISE + ANALYZE)'}
            </p>
            {mode === 'page' && (
              <p className="text-xs text-indigo-300/80 mt-1">
                执行身份只用勾选那行对应的<b>一个</b>配置（不会用该主页名下的其它关联账号重复发邀请），
                发邀请时再切到<b>该主页身份</b>；邀请发出后自动让「上面的配置」（授权对象本身）去点同意
                —— 走 FB 内部 GraphQL，不依赖界面语言。
              </p>
            )}
          </div>
          {error && <div className="text-rose-400 text-sm">{error}</div>}
          <button
            onClick={handleAssign}
            disabled={creating || !ready}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-50"
          >
            {creating
              ? (progress ? `执行队列中 ${progress.done}/${progress.total}…` : '提交队列中…')
              : (mode === 'adAccount'
                ? (source === 'profile' && addFriend ? '加好友并授权到个人号' : '广告号授权到个人号')
                : (source === 'profile' ? '主页授权到个人号（含对方自动同意）' : '主页授权到个人号'))}
          </button>
        </div>
      </div>
    </div>
  );
};
