import React from 'react';
import { useTranslation } from 'react-i18next';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: string;
  positive?: boolean;
  icon: React.ElementType;
}

export const StatCard = ({ title, value, change, positive, icon: Icon }: StatCardProps) => {
  const { t } = useTranslation();
  return (
    <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 hover:border-indigo-500/50 transition-all duration-300 shadow-sm">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-sm font-medium text-slate-400">{title}</p>
          <h3 className="text-xl font-bold text-white mt-2">{value}</h3>
        </div>
        <div className="p-2.5 bg-slate-800 rounded-lg text-indigo-400">
          <Icon className="w-5 h-5" />
        </div>
      </div>
      {change && (
        <div className="mt-3 flex items-center text-sm">
          <span className={positive ? "text-emerald-400" : "text-rose-400"}>
            {change}
          </span>
          <span className="text-slate-500 ml-2">{t('dashboard.fromLastMonth')}</span>
        </div>
      )}
    </div>
  );
};
