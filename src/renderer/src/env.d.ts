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
    }
  }
}

export {}
