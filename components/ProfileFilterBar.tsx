import React from 'react';
import { useTranslation } from 'react-i18next';

interface ProfileFilterBarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  groupFilter: string;
  onGroupFilterChange: (value: string) => void;
  groups: string[];
  enableTotp: boolean;
  onEnableTotpChange: (checked: boolean) => void;
}

export const ProfileFilterBar: React.FC<ProfileFilterBarProps> = ({
  searchTerm,
  onSearchChange,
  groupFilter,
  onGroupFilterChange,
  groups,
  enableTotp,
  onEnableTotpChange,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2 flex-wrap items-center">
      <input
        type="text"
        placeholder={t('profileManager.searchPlaceholder')}
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        className="w-[180px] bg-slate-950 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm"
      />
      <label className="flex items-center gap-1 text-xs text-slate-300 whitespace-nowrap">
        <input type="checkbox" checked={enableTotp} onChange={e => onEnableTotpChange(e.target.checked)} /> 实时2FA
      </label>
      <select
        value={groupFilter}
        onChange={e => { onGroupFilterChange(e.target.value); }}
        className="bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1.5 text-slate-300 outline-none max-w-[120px]"
      >
        <option value="">全部分组</option>
        {groups.map(g => <option key={g} value={g}>{g}</option>)}
      </select>
    </div>
  );
};
