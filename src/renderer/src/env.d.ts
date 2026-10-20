/// <reference types="vite/client" />

import type { WindowApi } from '../../shared/ipc/api'

declare module 'react'
{
  namespace JSX
  {
    interface IntrinsicElements
    {
      /** A customizable select's copy of its selected option, filled by the browser. */
      selectedcontent: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

declare global {
  const __APP_VERSION__: string
  interface Window {
    api: WindowApi
  }
}

export {}
