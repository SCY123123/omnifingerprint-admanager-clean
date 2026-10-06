import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n/i18n';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, message: String(error?.message || '页面错误') };
  }
  componentDidCatch(error: any, info: any) {}
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-slate-950 text-slate-300">
          <div className="text-center space-y-2">
            <div className="text-xl">页面出现错误</div>
            <div className="text-slate-400 text-sm">{this.state.message}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <React.Suspense fallback={<div className="flex h-screen w-full items-center justify-center bg-slate-950 text-slate-400">Loading...</div>}>
        <App />
      </React.Suspense>
    </ErrorBoundary>
  </React.StrictMode>
);
