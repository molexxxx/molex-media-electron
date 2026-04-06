/**
 * @module main/ytdlp
 * @description Barrel re-export for yt-dlp integration modules.
 *
 * Provides the same public API as the original monolithic `ytdlp.ts`
 * so all existing imports continue to work unchanged.
 */

// Stream URL token cache
export { registerStreamUrl, resolveStreamToken } from './cache'

// Binary management
export { ensureYtDlp } from './binary'

// URL resolution & audio stream extraction
export { resolvePlaylist, getAudioStreamUrl, cleanupAudioCache } from './resolver'
export type { PlaylistEntry, ResolvedTrack, AudioQuality } from './resolver'
