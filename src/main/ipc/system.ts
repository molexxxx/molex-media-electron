/**
 * @module main/ipc/system
 * @description IPC handlers for system information, log access, and
 * shell operations.
 */

import { ipcMain, shell } from 'electron'
import * as os from 'os'
import { execFile } from 'child_process'
import { getConfig, getLogDir } from '../config'
import { logger, type LogEntry } from '../logger'
import { getFFmpegVersion } from '../ffmpeg/bootstrap'
import { detectGpuMode, type GpuMode } from '../ffmpeg/gpu'
import { sendToAll } from './helpers'

/**
 * Compute CPU usage percentage by comparing the current os.cpus()
 * snapshot against the previous one. First call returns 0 since there
 * is no baseline yet. Subsequent calls return 0-100.
 */
let _prevCpuSnapshot: { idle: number; total: number } | null = null
function sampleCpuUsage(): number {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const c of cpus) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  const prev = _prevCpuSnapshot
  _prevCpuSnapshot = { idle, total }
  if (!prev) return 0
  const idleDelta = idle - prev.idle
  const totalDelta = total - prev.total
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

/**
 * Sample GPU usage percentage. NVIDIA via `nvidia-smi`; returns null on
 * other vendors / failures. Cached for 750ms so polling doesn't spawn
 * processes every tick.
 */
let _gpuUsageCache: { value: number | null; at: number } = { value: null, at: 0 }
async function sampleGpuUsage(): Promise<number | null> {
  const now = Date.now()
  if (now - _gpuUsageCache.at < 750) return _gpuUsageCache.value
  const value = await new Promise<number | null>((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 2000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const n = parseInt(stdout.toString().trim().split(/\r?\n/)[0] || '', 10)
        resolve(Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null)
      }
    )
  })
  _gpuUsageCache = { value, at: now }
  return value
}

/**
 * Detect the active GPU model name. Best-effort, platform-specific.
 * Result is cached for the lifetime of the process.
 *
 * - Windows: PowerShell `Get-CimInstance Win32_VideoController`.
 * - Linux:   `lspci` filtered to VGA/3D controllers.
 * - macOS:   `system_profiler SPDisplaysDataType`.
 */
let _gpuModelCache: string | null | undefined
async function detectGpuModelName(): Promise<string | null> {
  if (_gpuModelCache !== undefined) return _gpuModelCache
  const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : stdout.toString())
      })
    })

  try {
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
      ])
      // First non-empty line that isn't the generic basic display adapter.
      const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const real = candidates.find((n) => !/basic display|microsoft basic/i.test(n))
      _gpuModelCache = real || candidates[0] || null
    } else if (process.platform === 'linux') {
      const out = await run('sh', ['-c', "lspci -mm | grep -Ei 'vga|3d|display' | head -n 1"])
      // Format: "00:02.0 \"VGA compatible controller\" \"Intel ...\" \"UHD Graphics 620\" ..."
      const m = out.match(/"[^"]*"\s+"([^"]+)"\s+"([^"]+)"/)
      _gpuModelCache = m ? `${m[1]} ${m[2]}`.trim() : null
    } else if (process.platform === 'darwin') {
      const out = await run('system_profiler', ['SPDisplaysDataType'])
      const m = out.match(/Chipset Model:\s*(.+)/)
      _gpuModelCache = m ? m[1].trim() : null
    } else {
      _gpuModelCache = null
    }
  } catch {
    _gpuModelCache = null
  }
  if (_gpuModelCache) logger.info(`[gpu] Detected GPU model: ${_gpuModelCache}`)
  return _gpuModelCache
}

/** Register system-info, logging, and shell IPC handlers. */
export function registerSystemIPC(): void {
  // --- Logging ---
  ipcMain.handle('logs:getBuffer', () => {
    return logger.getBuffer()
  })

  ipcMain.handle('logs:clear', () => {
    logger.clearBuffer()
  })

  ipcMain.handle('logs:openDir', async () => {
    const logDir = getLogDir()
    shell.openPath(logDir)
  })

  // Log streaming - forward every log entry to all renderer windows
  logger.onLog((entry: LogEntry) => {
    try {
      sendToAll('logs:entry', entry)
    } catch { /* best-effort */ }
  })

  // --- System Info ---
  ipcMain.handle('system:info', async () => {
    const config = await getConfig()
    let ffmpegVersion = 'Not installed'
    if (config.ffmpegPath) {
      ffmpegVersion = await getFFmpegVersion(config.ffmpegPath)
    }
    const cpus = os.cpus()
    return {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
      cpuUsage: sampleCpuUsage(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      ffmpegVersion,
      appVersion: config.version
    }
  })

  ipcMain.handle('shell:openPath', async (_, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // GPU acceleration detection. Cached inside detectGpuMode so polling is
  // cheap. Returns the detected hardware encoder family + a human label.
  ipcMain.handle('system:gpu', async () => {
    const config = await getConfig()
    const gpuModel = await detectGpuModelName()
    if (!config.ffmpegPath) {
      return { mode: 'off' as GpuMode, label: 'detecting…', vendor: 'cpu', pending: true, gpuModel }
    }
    try {
      const mode = await detectGpuMode(config.ffmpegPath)
      const label = mode === 'nvenc' ? 'NVENC' : mode === 'qsv' ? 'Quick Sync' : mode === 'amf' ? 'AMF' : 'CPU only'
      const vendor = mode === 'nvenc' ? 'nvidia' : mode === 'qsv' ? 'intel' : mode === 'amf' ? 'amd' : 'cpu'
      return { mode, label, vendor, pending: false, gpuModel }
    } catch {
      return { mode: 'off' as GpuMode, label: 'CPU only', vendor: 'cpu', pending: false, gpuModel }
    }
  })

  // Lightweight GPU utilization poll. Returns null when no compatible
  // vendor tool is available (currently only NVIDIA via nvidia-smi).
  ipcMain.handle('system:gpuUsage', async () => {
    const usage = await sampleGpuUsage()
    return { usage }
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url)
    }
  })
}
