/**
 * Links the player takes: checking a pasted address, telling a site link (read through yt-dlp) from a direct media
 * address, and turning yt-dlp's errors into plain words with the way out.
 */

import { getExt, isMediaPath } from '../types'

/** A link the player can try: a page yt-dlp reads, or a direct address of a media file. */
export type LinkKind = 'site' | 'file'

/** The result of checking a pasted link. */
export type LinkCheck =
  | { ok: true, url: string, kind: LinkKind }
  | { ok: false, reason: string }

/** The words of link checking. */
export const LINK_REASONS = Object.freeze({
  empty: 'Paste a link to a video, a playlist, or a media file.',
  notWeb: 'Enter a web address that starts with https://.',
  incomplete: 'That address is not complete. Paste the whole link.'
})

/** Checks a pasted link. An address without a scheme, such as youtu.be/abc, is read as https. */
export function checkLink(text: string): LinkCheck
{
  const trimmed = text.trim()
  if (trimmed === '')
  {
    return { ok: false, reason: LINK_REASONS.empty }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try
  {
    parsed = new URL(withScheme)
  }
  catch
  {
    return { ok: false, reason: LINK_REASONS.incomplete }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
  {
    return { ok: false, reason: LINK_REASONS.notWeb }
  }
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')
  {
    return { ok: false, reason: LINK_REASONS.incomplete }
  }
  const last = parsed.pathname.split('/').pop() ?? ''
  const kind: LinkKind = last.includes('.') && isMediaPath(last) && getExt(last) !== '' ? 'file' : 'site'
  return { ok: true, url: parsed.href, kind }
}

/** A failure in words: what went wrong and the way out, plus yt-dlp's own line for those who want it. */
export interface LinkFailure
{
  message: string
  detail: string | null
}

const FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/unsupported url/i, 'yt-dlp cannot read this site. Check the address, or paste a direct link to a media file.'],
  [/private video/i, 'This video is private, so it cannot be played.'],
  [/confirm (?:you(?:'|’)re|you are) not a bot/i, 'The site asked to confirm you are not a bot. Choose a browser to sign in with under Settings, then try again.'],
  [/age[- ]restricted|confirm your age|inappropriate for some users|sign in to confirm/i,'This video needs a signed-in account. Choose a browser to sign in with under Settings, then try again.'],
  [/(?:video|content) (?:is )?unavailable|has been removed|no longer available/i, 'This video is unavailable. It may have been removed or blocked in your region.'],
  [/premieres in|live event will begin|is upcoming/i, 'This stream has not started yet. Try again when it is live.'],
  [/http error 404|not found/i, 'Nothing was found at this address. Check the link and try again.'],
  [/http error 429|too many requests/i, 'The site is limiting requests. Wait a few minutes, then try again.'],
  [/http error 403|forbidden/i, 'The site refused the request. Try again later.'],
  [/requested format is not available|no (?:video|picture) format/i, 'The link offers no format the player can play.'],
  [/getaddrinfo|enotfound|unable to download webpage|failed to resolve|timed out|econnreset|network/i, 'Could not reach the site. Check the internet connection, then try again.'],
  [/enoent|spawn/i, 'yt-dlp is not ready yet. Restart molexMedia, then try again.'],
  [/no tracks|playlist is empty|no entries/i, 'This link has no tracks to play.']
]

/** The last line yt-dlp printed as an error, without its "ERROR:" prefix and site tag. */
function detailOf(raw: string): string | null
{
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const error = [...lines].reverse().find((line) => /error/i.test(line)) ?? lines[lines.length - 1]
  if (error === undefined)
  {
    return null
  }
  return error.replace(/^.*?ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '').trim() || null
}

/** yt-dlp's error as plain words with the way out; anything unknown says yt-dlp could not read the link. */
export function describeLinkError(raw: string | null | undefined): LinkFailure
{
  const text = raw ?? ''
  const found = FAILURES.find(([pattern]) => pattern.test(text))
  return {
    message: found ? found[1] : 'yt-dlp could not read this link. Check the address, then try again.',
    detail: text.trim() === '' ? null : detailOf(text)
  }
}

/** How a finished lookup reads: "Found 1 track." or "Found 12 tracks." */
export function foundSentence(count: number): string
{
  return count === 1 ? 'Found 1 track.' : `Found ${count.toLocaleString('en-US')} tracks.`
}

/** What a lookup in progress says: what it is doing, and after a few seconds, how long it has been. */
export function lookupSentence(elapsedSeconds: number): string
{
  if (elapsedSeconds < 3)
  {
    return 'Reading the link with yt-dlp…'
  }
  return `Still reading the link (${Math.floor(elapsedSeconds)} s). Long playlists take a while.`
}

/** The picture quality a link plays at; Auto follows the screen. */
export type PictureQuality = 'auto' | '1080p' | '720p' | '480p'

/** The sound quality a link plays at. */
export type SoundQuality = 'best' | 'good' | 'low'

/** The tallest standard picture height that fits a screen of `screenPixels` physical rows, from 480 to 2160. */
export function autoPictureHeight(screenPixels: number): number
{
  const steps = [2160, 1440, 1080, 720, 480]
  const fit = steps.find((step) => screenPixels >= step)
  return fit ?? 480
}

/** The tallest picture a link plays at for a quality and screen. */
export function pictureHeightFor(quality: PictureQuality, screenPixels: number): number
{
  switch (quality)
  {
    case '1080p':
      return 1080
    case '720p':
      return 720
    case '480p':
      return 480
    default:
      return autoPictureHeight(screenPixels)
  }
}
