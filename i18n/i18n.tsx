import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';

i18n
  .use(HttpApi)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    lng: ((typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en',
    fallbackLng: ['zh', 'en'],
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    detection: { order: ['navigator'], caches: [] },
    backend: { loadPath: '/i18n/locales/{{lng}}.json' },
  });

export default i18n;
