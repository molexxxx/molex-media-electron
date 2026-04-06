/// <reference types="vite/client" />

declare global {
  const __APP_VERSION__: string
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
      registerLocalFile: (filePath: string) => Promise<string>
      getKnownFolders: () => Promise<{ name: string; path: string; icon: string }[]>
      browseDirectory: (dirPath: string) => Promise<{ success: boolean; entries: { name: string; path: string; isDirectory: boolean; size: number; ext: string }[]; parentPath: string; error?: string }>
      popoutPlayer: (state?: any) => Promise<void>
      isPopout: () => Promise<boolean>
      togglePin: () => Promise<boolean>
      isPinned: () => Promise<boolean>
      resizePopout: (width: number, height: number, save?: boolean) => Promise<void>
      getPopoutSize: () => Promise<{ width: number; height: number }>
      returnPlayerState: (state: any) => void
      onPopoutClosed: (cb: () => void) => () => void
      onReceivePlayerState: (cb: (state: any) => void) => () => void
      normalize: (filePaths: string[], outputDir?: string) => Promise<any>
      boost: (filePaths: string[], percent: number, outputDir?: string) => Promise<any>
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
      showTextContextMenu: () => void
      onNavigate: (cb: (view: string) => void) => () => void
      resolvePlaylist: (url: string) => Promise<{ success: boolean; entries: any[]; error?: string }>
      getStreamUrl: (videoUrl: string, quality?: string) => Promise<{ success: boolean; mediaUrl?: string; title?: string; duration?: number | null; error?: string }>
      pauseProcessing: () => Promise<void>
      resumeProcessing: () => Promise<void>
      getIsPaused: () => Promise<boolean>
      onPaused: (cb: () => void) => () => void
      onResumed: (cb: () => void) => () => void
      convert: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
      extract: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
      compress: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
      cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => Promise<any>
      mergeMedia: (segments: { path: string; inPoint: number; outPoint: number }[], options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => Promise<any>
      probeDetailed: (filePath: string) => Promise<any>
      remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      createPreview: (filePath: string) => Promise<{ success: boolean; previewUrl?: string; error?: string }>
      onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => () => void
      getUrlHistory: () => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      removeUrlHistory: (url: string) => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      clearUrlHistory: () => Promise<void>
      checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>
      installUpdate: () => Promise<void>
      onUpdaterStatus: (cb: (status: any) => void) => () => void
    }
  }
}

export {}
