import type { ElementType } from 'react';
import { CheckCircle, AlertTriangle, Ban, HelpCircle } from 'lucide-react';

// ==================== Status Badge Config ====================

export interface StatusBadgeConfig {
  color: 'emerald' | 'rose' | 'yellow' | 'amber' | 'slate';
  i18nKey: string;
  icon: ElementType;
  /** Fallback text used when i18n key is empty */
  fallback: string;
}

const STATUS_BADGE_MAP: Record<string, StatusBadgeConfig> = {
  Published:    { color: 'emerald', i18nKey: 'assetViewer.status.published',   icon: CheckCircle,    fallback: 'Published' },
  Unpublished:  { color: 'slate',   i18nKey: 'assetViewer.status.unpublished', icon: Ban,            fallback: 'Unpublished' },
  Active:       { color: 'emerald', i18nKey: 'assetViewer.status.active',      icon: CheckCircle,    fallback: 'Active' },
  Restricted:   { color: 'yellow',  i18nKey: 'assetViewer.status.restricted',  icon: AlertTriangle,  fallback: 'Restricted' },
  Ban:          { color: 'rose',    i18nKey: 'assetViewer.status.ban',         icon: Ban,            fallback: 'Ban' },
  'In Review':  { color: 'yellow',  i18nKey: 'assetViewer.status.inReview',   icon: AlertTriangle,  fallback: 'In Review' },
  Disabled:     { color: 'rose',    i18nKey: 'assetViewer.status.disabled',    icon: Ban,            fallback: 'Disabled' },
  verified:     { color: 'emerald', i18nKey: 'assetViewer.status.verified',    icon: CheckCircle,    fallback: 'verified' },
  not_verified: { color: 'amber',   i18nKey: 'assetViewer.status.notVerified', icon: AlertTriangle,  fallback: 'not_verified' },
  unknown:      { color: 'slate',   i18nKey: 'status.unknown',                 icon: HelpCircle,     fallback: 'Unknown' },
  Unknown:      { color: 'slate',   i18nKey: 'status.unknown',                 icon: HelpCircle,     fallback: 'Unknown' },
};

/**
 * Returns the StatusBadgeConfig for a given status string.
 * Falls back to a slate-coloured generic entry for unknown values.
 */
export function getStatusBadgeConfig(status: string): StatusBadgeConfig {
  return STATUS_BADGE_MAP[status] || {
    color: 'slate',
    i18nKey: '',
    icon: HelpCircle,
    fallback: status,
  };
}

// ==================== AdAccount numeric status code ====================

/**
 * adAccountStatus numeric code rendering:
 *   1 → 'emerald' (Active)
 *   2 → 'rose'    (Disabled)
 *   any other value → null (caller should fall through to string-based badge)
 */
export function getAdAccountStatusCodeColor(code: number): 'emerald' | 'rose' | null {
  if (code === 1) return 'emerald';
  if (code === 2) return 'rose';
  return null;
}

// ==================== 登录状态（profiles.login_status）====================

/**
 * 🔐 登录状态 → 文案 + 配色。由「获取信息」/「检查登录状态」写入并落库，
 * 值域：ok 已登录 / relogged 本次自动重登成功 / checkpoint 撞上人机验证需人工过
 *      / invalid Cookie 失效需人工登录 / 空 未检测。
 */
export function loginStatusView(raw: any): { label: string; className: string } {
  const s = String(raw ?? '').trim();
  if (s === 'ok') return { label: '已登录', className: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300' };
  if (s === 'relogged') return { label: '已自动重登', className: 'bg-amber-500/20 border-amber-500/50 text-amber-300' };
  if (s === 'checkpoint') return { label: '需人机验证', className: 'bg-orange-500/20 border-orange-500/50 text-orange-300' };
  if (s === 'invalid') return { label: '登录失效', className: 'bg-rose-500/20 border-rose-500/50 text-rose-300' };
  return { label: '未检测', className: 'bg-slate-700/60 border-slate-600 text-slate-400' };
}
