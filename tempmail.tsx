/**
 * 临时邮箱 —— 独立入口（不经过主系统的登录与布局）
 *
 * 与「左侧导航 → 临时邮箱」渲染的是同一个组件（components/EmailSystem.tsx），
 * 所以两处行为完全一致。它走的是同域 `/api/mailtm-proxy`、`/api/mailgw-proxy`，
 * 因此这个页面必须部署在能访问 /api/ 的站点下（当前是 https://your-domain.example/）。
 *
 * 访问方式：https://your-domain.example/tempmail （nginx 里配了 /tempmail → /tempmail.html）
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import EmailSystem from './components/EmailSystem';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <EmailSystem />
    </React.StrictMode>,
  );
}
