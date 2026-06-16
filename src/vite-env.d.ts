/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_VARIANT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
