import React, { useEffect, useMemo, useState } from 'react';
import { LOCAL_SERVER_SECRET, getLaunchServerUrl, selectionKeyOf } from '../utils/constants';
import { SearchSelect, useBusinessOptions } from './SearchSelect';
import type { AdAccountRow } from '../types';

interface AssignToBMDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sortedData: (AdAccountRow | any)[];
  selectedIds: Set<string>;
  uniqueIdKey: string;
  onRefresh: () => void;
  /** 当前登录 token，用于拉系统 BM 列表 */
  token?: string | null;
}

/**
 * 批量操作 → 授权到 BM。
 * 把选中的广告号加入（认领到）系统里的某个 BM，两种 Meta 语义完全不同的模式：
 *   claim  认领        POST /{bm}/owned_ad_accounts   广告号**归属**该 BM（一次性，认领后只能在 BM 里管）
 *                     返回 access_status：CONFIRMED 立即生效 / PENDING 等对方管理员批
 *   client 申请访问权限 POST /{bm}/client_ad_accounts  只申请使用权，等对方批，归属不变
 * 可选再把这些广告号分享给另一家 BM（合作伙伴）。
 * 都用广告号「所属配置」的 token 执行（号码归谁，就由谁去操作）。
 */
export const AssignToBMDialog: React.FC<AssignToBMDialogProps> = ({
  isOpen, onClose, sortedData, selectedIds, uniqueIdKey, onRefresh, token
}) => {
  const [businessId, setBusinessId] = useState('');
  const [mode, setMode] = useState<'claim' | 'client'>('claim');
  const [partnerBusinessId, setPartnerBusinessId] = useState('');
  const [tasks, setTasks] = useState<string[]>(['MANAGE', 'ADVERTISE', 'ANALYZE']);
  const [adAccountIdsInput, setAdAccountIdsInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const { options: bmOptions, list: bmList } = useBusinessOptions(token);
  const lurl = getLaunchServerUrl();

  // 🎯 选中的 BM 属于哪个配置。
  //    ⚠️ 认领 / 申请访问权限这两个操作，必须以「目标 BM 的管理员」身份发起 —— Meta 认领文档：
  //       「发送请求的用户必须是认领该广告账户的企业的管理员」。
  //       以前这里用**广告号所属配置**的 token，所以选别的配置的 BM 时必然报
  //       (#10) ...requires that you can MANAGE_AD_ACCOUNTS for this business account。
  const bmProfileId = useMemo(() => {
    const row = (bmList || []).find((b: any) =>
      String(b.businessId || b.business_id || b.id || '') === businessId
    );
    return String(row?.profile_id || row?.profileId || '');
  }, [bmList, businessId]);

  useEffect(() => {
    if (isOpen) {
      setBusinessId(''); setMode('claim'); setPartnerBusinessId('');
      setTasks(['MANAGE', 'ADVERTISE', 'ANALYZE']);
      setAdAccountIdsInput(''); setError('');
    }
  }, [isOpen]);

  const handleAssign = async () => {
    if (!businessId) { setError('请选择要授权到的 BM（可输入名称或 ID 搜索）'); return; }
    if (partnerBusinessId && partnerBusinessId === businessId) {
      setError('合作伙伴 BM 不能和目标 BM 是同一家');
      return;
    }

    let assetIds: string[] = [];
    if (adAccountIdsInput.trim()) {
      assetIds = adAccountIdsInput.split(/[,;\s]+/).map(s => s.replace(/^act_/, '').trim()).filter(Boolean);
    } else {
      // ⚠️ selectedIds 存的是「配置ID::资产ID」复合键，必须从选中行取真实资产 ID
      assetIds = Array.from(new Set(
        sortedData
          .filter(item => selectedIds.has(selectionKeyOf(item, uniqueIdKey)))
          .map(item => String((item as any)[uniqueIdKey] || ''))
          .filter(Boolean)
      ));
    }
    if (assetIds.length === 0) { setError('没有可授权的广告号'); return; }
    // 🎯 主操作必须以「目标 BM 的管理员」身份发起。BM 列表里查不到归属配置时不能瞎猜 ——
    //    用广告号那边的 token 只会稳定报 (#10) MANAGE_AD_ACCOUNTS，不如直接说清楚怎么修。
    if (!bmProfileId) {
      setError(`系统里查不到 BM ${businessId} 的归属配置，无法以 BM 管理员身份操作 —— 请先去「BM 列表」页刷新一次，再回来重试`);
      return;
    }

    try {
      setCreating(true);
      setError('');
      // 按广告号所属配置分组：主操作统一用 BM 所属配置的 token（profileId），
      // 这一组自己的配置只作为「分享合作伙伴」那一步的身份（assetProfileId）。
      const byProfile = new Map<string, string[]>();
      for (const item of sortedData) {
        const id = String(item[uniqueIdKey as keyof typeof item]);
        if (!assetIds.includes(id)) continue;
        const pid = String((item as any).profileId || (item as any).profile_id || '');
        if (!byProfile.has(pid)) byProfile.set(pid, []);
        byProfile.get(pid)!.push(id);
      }

      let ok = 0, fail = 0;
      const details: any[] = [];
      for (const [pid, ids] of byProfile) {
        const resp = await fetch(`${lurl}/api/facebook/adaccounts/assign-to-bm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Secret': LOCAL_SERVER_SECRET },
          body: JSON.stringify({
            profileId: bmProfileId, assetProfileId: pid,
            adAccountIds: ids, businessId, tasks,
            mode,
            partnerBusinessId: partnerBusinessId || undefined
          })
        });
        const json = await resp.json();
        if (Array.isArray(json.results)) {
          ok += json.results.filter((r: any) => r.status === 'success').length;
          fail += json.results.filter((r: any) => r.status === 'error').length;
          details.push(...json.results);
        } else {
          fail += ids.length;
          // 整批失败（例如「配置缺 Access Token」）时后端没有 results：这里标明是「配置级」错误，
          // 否则 pid（配置 ID）会被当成广告号 ID 显示，出现「-4146: 配置 4142 缺少…」这种自相矛盾的标题
          details.push({ adAccountId: `配置 ${pid}`, status: 'error', message: json.message || '请求失败' });
        }
      }

      const modeLabel = mode === 'client' ? '申请访问权限' : '认领';
      const partnerLabel = partnerBusinessId ? `，并分享给合作伙伴 ${partnerBusinessId}` : '';
      const detailLines = details.slice(0, 5).map(d => `- ${d.adAccountId}: ${d.message}`).join('\n');
      if (fail === 0) {
        alert(`${modeLabel}到 BM 成功: ${ok} 个广告号 → ${businessId}${partnerLabel}\n\n${detailLines}`);
        onClose();
        onRefresh();
      } else {
        alert(`${modeLabel}到 BM 完成: 成功 ${ok} 个,失败 ${fail} 个${partnerLabel}\n\n详情:\n${detailLines}${details.length > 5 ? '\n...' : ''}`);
        onRefresh();
      }
    } catch (e) { setError(`请求失败: ${(e as Error).message}`); }
    finally { setCreating(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">授权广告号到 BM</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">
              目标 BM <span className="text-rose-400">*</span>
            </label>
            <SearchSelect
              value={businessId}
              onChange={setBusinessId}
              options={bmOptions}
              placeholder="-- 搜索并选择系统里的 BM --"
              searchPlaceholder="输入 BM 名称或 BM ID 搜索"
              emptyText="没有取到系统 BM 列表（先去「BM 列表」页刷新一次）"
            />
            <p className="text-xs text-slate-500 mt-1">列表来自系统已有的 BM，支持按 BM 名称或 BM ID 搜索。</p>
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">操作类型</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode('claim')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs border ${mode === 'claim' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300'}`}>
                认领
              </button>
              <button type="button" onClick={() => setMode('client')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs border ${mode === 'client' ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300'}`}>
                申请访问权限
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {mode === 'claim'
                ? '广告号归属该 BM（一次性）。你是广告号管理员就立即生效，否则会发认领请求等管理员批准。'
                : '只申请使用权，归属不变，等对方广告号管理员批准后才生效。'}
            </p>
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">
              广告号 ID <span className="text-slate-500 font-normal">(留空使用勾选的 {selectedIds.size} 个)</span>
            </label>
            <textarea
              value={adAccountIdsInput}
              onChange={e => setAdAccountIdsInput(e.target.value)}
              placeholder="可选: act_123, act_456 或纯数字，用逗号/空格/换行分隔"
              className="w-full bg-slate-950 border border-slate-700 text-slate-200 px-3 py-2 rounded-lg text-sm font-mono min-h-[56px] resize-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">权限</label>
            <div className="flex flex-wrap gap-3">
              {['MANAGE', 'ADVERTISE', 'ANALYZE'].map(task => (
                <label key={task} className="inline-flex items-center gap-1.5 text-slate-300 text-sm">
                  <input type="checkbox" checked={tasks.includes(task)}
                    onChange={e => setTasks(prev => e.target.checked ? [...prev, task] : prev.filter(x => x !== task))}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600" />
                  {task === 'MANAGE' ? '管理' : task === 'ADVERTISE' ? '广告' : '分析'}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-slate-300">
                分享合作伙伴 <span className="text-slate-500 font-normal">(可选)</span>
              </label>
              {partnerBusinessId && (
                <button type="button" onClick={() => setPartnerBusinessId('')}
                  className="text-xs text-slate-400 hover:text-slate-200">清除</button>
              )}
            </div>
            <SearchSelect
              value={partnerBusinessId}
              onChange={setPartnerBusinessId}
              options={bmOptions}
              placeholder="-- 不分享，或选一家合作伙伴 BM --"
              searchPlaceholder="输入 BM 名称或 BM ID 搜索"
              emptyText="没有取到系统 BM 列表（先去「BM 列表」页刷新一次）"
            />
            <p className="text-xs text-slate-500 mt-1">填了就在上面操作成功后，再把这些广告号分享给这家 BM。</p>
          </div>

          {error && <div className="text-rose-400 text-sm">{error}</div>}
          <button onClick={handleAssign} disabled={creating || !businessId}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-50">
            {creating ? '处理中…' : (mode === 'client' ? '申请访问权限' : '认领到 BM')}
          </button>
        </div>
      </div>
    </div>
  );
};
