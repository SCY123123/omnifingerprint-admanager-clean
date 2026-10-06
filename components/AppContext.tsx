import React, { createContext, useContext, useState, useMemo } from 'react';
import type { FingerprintProfile, AuthUser, ToastType } from '../types';

/** 应用级共享状态 */
interface AppContextValue {
  /** 当前登录用户 */
  user: AuthUser | null;
  setUser: (u: AuthUser | null) => void;
  /** 认证 Token */
  token: string | null;
  setToken: (t: string | null) => void;
  /** 浏览器配置列表 */
  profiles: FingerprintProfile[];
  setProfiles: (p: FingerprintProfile[]) => void;
  /** 当前用户是否为超级管理员 */
  isSuperadmin: boolean;
  /** 当前 Platform 筛选 */
  platform: string;
  setPlatform: (p: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export const useAppContext = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
};

interface AppProviderProps {
  children: React.ReactNode;
  initialUser?: AuthUser | null;
  initialToken?: string | null;
  initialProfiles?: FingerprintProfile[];
  initialPlatform?: string;
}

export const AppProvider: React.FC<AppProviderProps> = ({
  children,
  initialUser = null,
  initialToken = null,
  initialProfiles = [],
  initialPlatform = '',
}) => {
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [token, setToken] = useState<string | null>(initialToken);
  const [profiles, setProfiles] = useState<FingerprintProfile[]>(initialProfiles);
  const [platform, setPlatform] = useState(initialPlatform);

  // 🐛 修复：profiles 以前只把 initialProfiles 当「初始值」，而 App 传进来时还是 []
  //   （真正的全量列表是挂载后才异步拉回来的），prop 变化不会同步进 context ——
  //   结果 ctx.profiles 长期为空：所有依赖它反查「配置名 / 归属邮箱 / token」的功能静默失效
  //   （广告号列表的配置名走接口的 profile_name 所以看不出来，新加的「选系统配置」下拉就直接是空的）。
  //   这里跟随 prop 同步，保持与 App 的列表一致。
  React.useEffect(() => {
    if (Array.isArray(initialProfiles)) setProfiles(initialProfiles);
  }, [initialProfiles]);

  const isSuperadmin = useMemo(() => user?.role === 'superadmin', [user]);

  const value = useMemo<AppContextValue>(() => ({
    user, setUser,
    token, setToken,
    profiles, setProfiles,
    isSuperadmin,
    platform, setPlatform,
  }), [user, token, profiles, isSuperadmin, platform]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};
