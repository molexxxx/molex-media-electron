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
      selectSavePath: (defaultName: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>
      scanDirectory: (dirPath: string) => Promise<{ path: string; name: string; size: number; ext: string }[]>
      probeFile: (filePath: string) => Promise<any>
      getFilePath: (file: File) => string
      registerLocalFile: (filePath: string) => Promise<string>
      seekLocalFile: (filePath: string, seekTime: number) => Promise<string>
      clearPlaybackCache: (filePath: string) => Promise<void>
      readFileBuffer: (filePath: string) => Promise<ArrayBuffer>
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
      getPlayerState: () => Promise<any>
      normalize: (filePaths: string[], normalizeOptions?: { I: number; TP: number; LRA: number }, outputDir?: string) => Promise<any>
      boost: (filePaths: string[], percent: number, outputDir?: string) => Promise<any>
      startBatchQueue: (taskSpecs: Array<{
        filePath: string; operation: string; outputDir?: string;
        boostPercent?: number; normalizeOptions?: any; convertOptions?: any; extractOptions?: any; compressOptions?: any
      }>) => Promise<any>
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
      openExternal: (url: string) => Promise<void>
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      showTextContextMenu: () => void
      onCloseConfirm: (cb: () => void) => () => void
      closeConfirmResponse: (action: 'minimize' | 'quit', dontAskAgain: boolean) => void
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
      mergeMedia: (segments: { path: string; inPoint: number; outPoint: number; audioReplacement?: { path: string; offset: number; trimIn: number; trimOut: number } }[], options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => Promise<any>
      probeDetailed: (filePath: string) => Promise<any>
      remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      createPreview: (filePath: string) => Promise<{ success: boolean; previewUrl?: string; data?: string; error?: string }>
      createAudioPreview: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
      exportTimeline: (request: any) => Promise<{ success: boolean; outputPath?: string; error?: string }>
      cancelExport: () => Promise<{ success: boolean; error?: string }>
      extractThumbnail: (filePath: string, timeSec: number) => Promise<{ success: boolean; data?: string; error?: string }>
      extractThumbnailStrip: (filePath: string, durationSeconds: number) => Promise<{ success: boolean; interval?: number; frames?: string[]; error?: string }>
      extractWaveform: (filePath: string, numSamples?: number) => Promise<{ success: boolean; data?: number[]; error?: string }>
      replaceAudio: (videoPath: string, audioPath: string, options?: { outputDir?: string; audioOffset?: number; inPoint?: number; outPoint?: number }) => Promise<any>
      onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => () => void
      getUrlHistory: () => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      removeUrlHistory: (url: string) => Promise<{ url: string; title: string; trackCount: number; addedAt: number }[]>
      clearUrlHistory: () => Promise<void>
      checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>
      installUpdate: () => Promise<void>
      getUpdaterStatus: () => Promise<{ status: string; version?: string; error?: string; percent?: number }>
      onUpdaterStatus: (cb: (status: any) => void) => () => void
    }
  }
}

export {}
