/**
 * 智能广告发布平台 —— 独立入口（不经过主系统的登录与布局）
 *
 * 与「自动化 → 智能发布平台」渲染的是同一个组件（components/AdPublishHub.tsx）。
 *
 * ⚠️ AdPublishHub 内部用了 useAppContext()，而它在没有 Provider 时会直接抛错，
 *    所以这里必须自己包一层 AppProvider（不需要登录态：页面本身只做选广告号 + 发布）。
 *    profiles 为空也没关系 —— AdPublishHub 会退化成显示配置 ID，并在可能时自己拉一份。
 *
 * 访问方式：https://your-domain.example/adpublish （nginx 里配了 /adpublish → /adpublish.html）
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './components/AppContext';
import { AdPublishHub } from './components/AdPublishHub';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <AppProvider>
        <AdPublishHub />
      </AppProvider>
    </React.StrictMode>,
  );
}
