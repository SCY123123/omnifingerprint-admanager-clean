import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, AdCampaign } from '../types';
import { generateAdCopy } from '../services/geminiService';
import { Wand2, Send, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

export const AdAutomation = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [generatedText, setGeneratedText] = useState('');
  const [formData, setFormData] = useState({
    platform: Platform.META,
    productName: '',
    description: '',
    tone: 'Persuasive and Urgent'
  });
  const [publishStatus, setPublishStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const tones = [
    'Persuasive and Urgent',
    'Friendly and Casual',
    'Professional and Authoritative',
    'Luxury and Elegant',
    'Viral / Gen-Z Style'
  ];

  const handleGenerate = async () => {
    if (!formData.productName || !formData.description) return;
    setLoading(true);
    setPublishStatus('idle');
    try {
      const text = await generateAdCopy(
        formData.productName,
        formData.description,
        formData.platform,
        formData.tone
      );
      setGeneratedText(text);
    } catch (e) {
      console.error(e);
      setGeneratedText(t('adAutomation.generationError'));
    } finally {
      setLoading(false);
    }
  };

  const handlePublish = () => {
    // Simulation of official API call
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setPublishStatus('success');
    }, 2000);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Input Section */}
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-white">{t('adAutomation.title')}</h2>
          <p className="text-slate-400 mt-1">{t('adAutomation.subtitle')}</p>
        </div>

        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{t('adAutomation.labels.platform')}</label>
            <select
              value={formData.platform}
              onChange={(e) => setFormData({ ...formData, platform: e.target.value as Platform })}
              className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
            >
              {Object.values(Platform).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{t('adAutomation.labels.productName')}</label>
            <input
              type="text"
              value={formData.productName}
              onChange={(e) => setFormData({ ...formData, productName: e.target.value })}
              placeholder={t('adAutomation.placeholders.productName')}
              className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{t('adAutomation.labels.productDetails')}</label>
            <textarea
              rows={4}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={t('adAutomation.placeholders.productDetails')}
              className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">{t('adAutomation.labels.tone')}</label>
            <select
              value={formData.tone}
              onChange={(e) => setFormData({ ...formData, tone: e.target.value })}
              className="w-full bg-slate-950 border border-slate-700 text-white rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
            >
              {tones.map(tone => <option key={tone}>{t(`adAutomation.tones.${tone.replace(/ \/ | /g, '')}`)}</option>)}
            </select>
          </div>

          <button
            onClick={handleGenerate}
            disabled={loading || !formData.productName}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg font-medium transition-all ${
              loading || !formData.productName
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:shadow-lg hover:shadow-indigo-500/25'
            }`}
          >
            {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Wand2 className="w-5 h-5" />}
            {t('adAutomation.generateButton')}
          </button>
        </div>
      </div>

      {/* Preview & Publish Section */}
      <div className="space-y-6">
         <div className="h-[70px] hidden lg:block"></div> {/* Spacer to align with title */}
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 h-full flex flex-col">
           <h3 className="text-lg font-semibold text-white mb-4">{t('adAutomation.previewTitle')}</h3>

           <div className="flex-1 bg-slate-950 rounded-lg border border-slate-800 p-4 font-mono text-sm text-slate-300 overflow-y-auto whitespace-pre-wrap min-h-[200px]">
             {generatedText ? generatedText : <span className="text-slate-600 italic">{t('adAutomation.previewPlaceholder')}</span>}
           </div>

           <div className="mt-6 pt-6 border-t border-slate-800">
             <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
               <div className="text-sm text-slate-400 text-center sm:text-left">
                 {t('adAutomation.accountLabel')}: <span className="text-white font-medium">Main Business Manager (ID: 4421)</span>
               </div>
               <button
                 onClick={handlePublish}
                 disabled={!generatedText || loading}
                 className={`w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium transition-colors ${
                   !generatedText
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                 }`}
               >
                 <Send className="w-4 h-4" /> {t('adAutomation.publishButton')}
               </button>
             </div>

             {publishStatus === 'success' && (
               <div className="mt-4 p-3 bg-emerald-900/20 border border-emerald-900 rounded-lg flex items-center gap-2 text-emerald-400 text-sm animate-in fade-in slide-in-from-bottom-2">
                 <CheckCircle2 className="w-4 h-4" />
                 {t('adAutomation.publishSuccess', { platform: formData.platform })}
               </div>
             )}
              {publishStatus === 'error' && (
               <div className="mt-4 p-3 bg-rose-900/20 border border-rose-900 rounded-lg flex items-center gap-2 text-rose-400 text-sm">
                 <AlertCircle className="w-4 h-4" />
                 {t('adAutomation.publishError')}
               </div>
             )}
           </div>
        </div>
      </div>
    </div>
  );
};
