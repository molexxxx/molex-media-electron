/// <reference types="vite/client" />

declare global {
  interface Window {
    electron: any
    api: {
      loadConfig: () => Promise<any>
      saveConfig: (partial: any) => Promise<any>
      getConfig: () => Promise<any>
      checkFFmpeg: () => Promise<{ found: boolean; version?: string; ffmpeg?: string; ffprobe?: string }>
      downloadFFmpeg: () => Promise<{ success: boolean; version?: string; error?: string; ffmpeg?: string; ffprobe?: string }>
      getFFmpegVersion: () => Promise<string>
      onDownloadProgress: (cb: (progress: any) => void) => () => void
      openFiles: () => Promise<string[]>
      openDirectory: () => Promise<string | null>
      selectOutputDir: () => Promise<string | null>
      scanDirectory: (dirPath: string) => Promise<{ path: string; name: string; size: number; ext: string }[]>
      probeFile: (filePath: string) => Promise<any>
      getFilePath: (file: File) => string
      popoutPlayer: (state?: any) => Promise<void>
      isPopout: () => Promise<boolean>
      togglePin: () => Promise<boolean>
      isPinned: () => Promise<boolean>
      returnPlayerState: (state: any) => void
      onPopoutClosed: (cb: () => void) => () => void
      onReceivePlayerState: (cb: (state: any) => void) => () => void
      normalize: (filePaths: string[]) => Promise<any>
      boost: (filePaths: string[], percent: number) => Promise<any>
      cancelBatch: (batchId: string) => Promise<boolean>
      cancelAll: () => Promise<boolean>
      getActiveCount: () => Promise<number>
      onBatchStarted: (cb: (data: any) => void) => () => void
      onTaskProgress: (cb: (task: any) => void) => () => void
      onBatchComplete: (cb: (data: any) => void) => () => void
      getLogBuffer: () => Promise<any[]>
      clearLogs: () => Promise<void>
      openLogDir: () => Promise<void>
      onLogEntry: (cb: (entry: any) => void) => () => void
      getSystemInfo: () => Promise<any>
      showInFolder: (filePath: string) => Promise<void>
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      onNavigate: (cb: (view: string) => void) => () => void
      resolvePlaylist: (url: string) => Promise<{ success: boolean; entries: any[]; error?: string }>
      getStreamUrl: (videoUrl: string, quality?: string) => Promise<{ success: boolean; mediaUrl?: string; title?: string; duration?: number | null; error?: string }>
      pauseProcessing: () => Promise<void>
      resumeProcessing: () => Promise<void>
      getIsPaused: () => Promise<boolean>
      onPaused: (cb: () => void) => () => void
      onResumed: (cb: () => void) => () => void
      convert: (filePaths: string[], options: any) => Promise<any>
      extract: (filePaths: string[], options: any) => Promise<any>
      compress: (filePaths: string[], options: any) => Promise<any>
      cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: { mode?: 'fast' | 'precise'; outputFormat?: string }) => Promise<any>
      mergeMedia: (segments: { path: string; inPoint: number; outPoint: number }[], options?: { mode?: 'fast' | 'precise'; outputFormat?: string }) => Promise<any>
      probeDetailed: (filePath: string) => Promise<any>
      remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      getUrlHistory: () => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      removeUrlHistory: (url: string) => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      clearUrlHistory: () => Promise<void>
    }
  }
}

export {}
