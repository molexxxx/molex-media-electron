/// <reference types="vite/client" />

import type { WindowApi } from '../../shared/ipc/api'

declare global {
  const __APP_VERSION__: string
  interface Window {
    api: WindowApi
  }
}

export {}
