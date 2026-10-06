import React from 'react';
import { useTranslation } from 'react-i18next';
import { FingerprintProfile, Platform } from '../types';
import { Layers, Wallet, Globe } from 'lucide-react';

interface AssetsManagerProps {
  profiles: FingerprintProfile[];
  platform: Platform;
}

export const AssetsManager = ({ profiles, platform }: AssetsManagerProps) => {
  const { t } = useTranslation();

  const filteredProfiles = profiles.filter(p => 
    (p.platform === platform) && p.assets && Object.keys(p.assets).length > 0
  );
  
  const getPaymentStatusBadge = (status?: 'Active' | 'Failed' | 'None') => {
    switch (status) {
      case 'Active':
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-900/30 text-emerald-400 border border-emerald-800">Active</span>;
      case 'Failed':
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-900/30 text-rose-400 border border-rose-800">Failed</span>;
      default:
        return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">None</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">{t('assetsManager.title')}</h2>
        <p className="text-slate-400 mt-1">{t('assetsManager.subtitle')}</p>
      </div>

      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 font-medium uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.profile')}</th>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.platform')}</th>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.bm')}</th>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.pages')}</th>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.adAccounts')}</th>
                <th className="px-6 py-4 whitespace-nowrap">{t('assetsManager.table.payment')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredProfiles.length > 0 ? filteredProfiles.map((profile) => (
                <tr key={profile.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className="px-6 py-4">
                    <p className="font-medium text-white">{profile.name}</p>
                    <p className="text-xs text-slate-500 font-mono">{profile.id}</p>
                  </td>
                  <td className="px-6 py-4 text-slate-300">{profile.platform}</td>
                  <td className="px-6 py-4">
                    {profile.assets?.bmId ? (
                        <div className="flex flex-col">
                            <span className="font-mono text-slate-200">{profile.assets.bmId}</span>
                        </div>
                    ) : (
                      <span className="text-slate-600">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-medium text-slate-200">{profile.assets?.pagesCount ?? <span className="text-slate-600">0</span>}</td>
                  <td className="px-6 py-4 font-medium text-slate-200">{profile.assets?.adAccountsCount ?? <span className="text-slate-600">0</span>}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      {getPaymentStatusBadge(profile.assets?.paymentStatus)}
                      {profile.assets?.currency && (
                        <span className="text-xs text-slate-400 font-mono">{profile.assets.country} / {profile.assets.currency}</span>
                      )}
                    </div>
                  </td>
                </tr>
              )) : (
                <tr>
                    <td colSpan={6} className="text-center py-16 text-slate-500">
                        <Layers className="w-8 h-8 mx-auto mb-2" />
                        No assets found for this platform.
                    </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
