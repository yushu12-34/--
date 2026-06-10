interface ImportMetaEnv {
  readonly VITE_INTERNAL_API_BASE_URL?: string;
  readonly VITE_INTERNAL_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
