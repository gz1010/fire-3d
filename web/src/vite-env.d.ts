/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "off" renders a placeholder instead of the 3D scene (UI work without WebGL). */
  readonly VITE_SCENE?: string
  /** Optional absolute API origin; default '' = same origin (Vite proxies /api). */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
