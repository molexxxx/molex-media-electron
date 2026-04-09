/**
 * @module main/ytdlp
 * @description Barrel re-export for yt-dlp integration modules.
 */

// Stream URL token cache
export { registerStreamUrl, resolveStreamToken } from './cache'

// Cookie browser management
export { getInstalledBrowsers, setBrowserAndExport, clearCookies, getCookieInfo } from './cookies'

// Binary management
export { ensureYtDlp } from './binary'

// URL resolution & audio stream extraction
export { resolvePlaylist, getAudioStreamUrl, cleanupAudioCache } from './resolver'
export type { PlaylistEntry, ResolvedTrack, AudioQuality } from './resolver'
