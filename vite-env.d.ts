/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 本地 PUP 服务器鉴权密钥（构建时注入） */
  readonly VITE_LOCAL_SERVER_SECRET?: string;
  /** 私有收信域名（构建时注入） */
  readonly VITE_MAIL_DOMAIN?: string;
  /** 本地 PUP 服务器地址 */
  readonly VITE_LAUNCH_SERVER_URL?: string;
  /** 存储后端地址 */
  readonly VITE_STORAGE_SERVER_URL?: string;
  readonly VITE_ADPOS_EMAIL?: string;
  readonly VITE_ADPOS_PASSWORD?: string;
  readonly VITE_ADPOS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
