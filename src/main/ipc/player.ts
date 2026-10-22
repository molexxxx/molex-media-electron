/**
 * @module main/ipc/player
 * @description The media player's channels: inspecting a file, serving the chosen audio track, serving the picture
 * as it is, remuxed, or converted while it plays (with a picture subtitle drawn on), text subtitles as WebVTT, a
 * link's picture stream, and live or HLS-only links streamed through FFmpeg.
 */

import { ipcMain } from 'electron'
import { logger } from '../logger'
import { DEFAULT_DISPLAY_BOX, extractSubtitles, inspectForPlayback, linkStreamCommand, pictureDecodeCommand, prepareForPlayback, prepareForPlaybackAt, prepareRemuxedPicture, probeStreamInput, PICTURE_STREAM_TYPE, STREAM_SOUND_TYPE } from '../ffmpeg/playback'
import { downloadLinkVideo, getLinkData, getLinkVideo, planLinkStream, rememberLinkData, withProbedFormats, withProbedSound, type VideoCodecFamily } from '../ytdlp/resolver'
import { registerLiveSession, registerLiveStream, registerPreviewPath, registerStreamProxy, startPreviewServer } from '../preview-server'
import type { PlayRoute } from '../../shared/player/media'
import type { LinkProgress, LinkStreamRequest, PictureOptions, PictureSource, PictureSubtitle, PlayerResult } from '../../shared/ipc/api'

function failure(err: unknown): { ok: false, error: string }
{
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function positive(value: unknown, fallback: number): number
{
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** The codec families a renderer named, keeping only the known ones; H.264 when it named none. */
function codecFamilies(codecs: unknown): VideoCodecFamily[]
{
  return Array.isArray(codecs) ? codecs.filter((c): c is VideoCodecFamily => c === 'avc1' || c === 'vp9' || c === 'av01') : ['avc1']
}

/** A picture subtitle from the renderer with whole, positive numbers, or null. */
export function pictureSubtitleOf(value: unknown): PictureSubtitle | null
{
  const subtitle = value as Partial<PictureSubtitle> | null | undefined
  if (typeof subtitle?.streamIndex !== 'number' || !Number.isInteger(subtitle.streamIndex) || subtitle.streamIndex < 0)
  {
    return null
  }
  const scale = subtitle.scaleTo
  const scaleTo = scale && positive(scale.width, 0) > 0 && positive(scale.height, 0) > 0 ? { width: Math.round(scale.width), height: Math.round(scale.height) } : null
  return { streamIndex: subtitle.streamIndex, scaleTo }
}

/** Register the player's channels. */
export function registerPlayerIPC(): void
{
  ipcMain.handle('player:inspect', async (_, filePath: string): Promise<PlayerResult<'media'>> =>
  {
    try
    {
      return { ok: true, media: await inspectForPlayback(filePath) }
    }
    catch (err)
    {
      logger.warn(`Player could not inspect ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      return failure(err)
    }
  })

  ipcMain.handle('player:soundUrl', async (_, filePath: string, audioIndex: number, seekTime: number | null, route?: PlayRoute): Promise<PlayerResult<'url'>> =>
  {
    try
    {
      const index = Number.isInteger(audioIndex) && audioIndex >= 0 ? audioIndex : 0
      const local = route === 'direct'
        ? filePath
        : seekTime !== null && seekTime > 0 ? await prepareForPlaybackAt(filePath, seekTime, index) : await prepareForPlayback(filePath, index)
      const base = await startPreviewServer()
      return { ok: true, url: `${base}/${registerPreviewPath(local)}` }
    }
    catch (err)
    {
      return failure(err)
    }
  })

  ipcMain.handle('player:pictureUrl', async (_, filePath: string, streamIndex: number, route: PlayRoute, seekTime: number, options?: PictureOptions): Promise<PlayerResult<'picture'>> =>
  {
    try
    {
      const base = await startPreviewServer()
      if (route === 'convert')
      {
        const start = Number.isFinite(seekTime) && seekTime > 0 ? seekTime : 0
        const display = {
          width: positive(options?.width, DEFAULT_DISPLAY_BOX.width),
          height: positive(options?.height, DEFAULT_DISPLAY_BOX.height),
          fps: typeof options?.fps === 'number' && options.fps > 0 ? options.fps : null,
          software: options?.software === true,
          subtitle: pictureSubtitleOf(options?.subtitle)
        }
        const { command, args, encoder } = await pictureDecodeCommand(filePath, streamIndex, start, display)
        const picture: PictureSource = { url: `${base}/${registerLiveStream({ command, args, contentType: PICTURE_STREAM_TYPE })}`, live: true, offset: start, encoder }
        return { ok: true, picture }
      }
      const local = route === 'remux' ? await prepareRemuxedPicture(filePath, streamIndex) : filePath
      return { ok: true, picture: { url: `${base}/${registerPreviewPath(local)}`, live: false, offset: 0, encoder: null } }
    }
    catch (err)
    {
      return failure(err)
    }
  })

  ipcMain.handle('player:subtitles', async (_, filePath: string, streamIndex: number): Promise<PlayerResult<'vtt'>> =>
  {
    try
    {
      return { ok: true, vtt: await extractSubtitles(filePath, streamIndex) }
    }
    catch (err)
    {
      return failure(err)
    }
  })

  ipcMain.handle('player:linkStream', async (_, pageUrl: string, request: LinkStreamRequest): Promise<PlayerResult<'stream'>> =>
  {
    try
    {
      const codecs = codecFamilies(request?.codecs)
      const want = {
        sound: request?.sound !== false,
        picture: request?.picture === true,
        soundQuality: request?.soundQuality === 'good' || request?.soundQuality === 'low' ? request.soundQuality : 'best' as const,
        maxHeight: positive(request?.maxHeight, 1080),
        codecs
      }
      const data = await withProbedFormats(await getLinkData(pageUrl, request?.fresh === true), probeStreamInput)
      rememberLinkData(pageUrl, data)
      const plan = await withProbedSound(planLinkStream(data, want), probeStreamInput)
      if (want.sound && plan.sound === null)
      {
        throw new Error('No sound format the player can stream')
      }
      if (plan.sound === null && plan.picture === null)
      {
        throw new Error('No picture format the player can stream')
      }
      const at = typeof request?.at === 'number' && Number.isFinite(request.at) && request.at > 0 ? request.at : null
      const { command, args, outputs, encoder } = await linkStreamCommand(plan, {
        at,
        copyFamilies: codecs,
        width: positive(request?.display?.width, DEFAULT_DISPLAY_BOX.width),
        height: positive(request?.display?.height, DEFAULT_DISPLAY_BOX.height),
        software: request?.display?.software === true
      })
      const base = await startPreviewServer()
      const tokens = registerLiveSession({ command, args, outputs: outputs.map((part) => part === 'sound' ? STREAM_SOUND_TYPE : PICTURE_STREAM_TYPE) })
      const urlOf = (part: 'sound' | 'picture'): string | null =>
      {
        const index = outputs.indexOf(part)
        return index < 0 ? null : `${base}/${tokens[index]}`
      }
      const pictureUrl = urlOf('picture')
      logger.info(`Player streams ${plan.live ? 'the live link' : 'the link'} ${pageUrl} through FFmpeg (${outputs.join(' and ')}${at === null ? '' : ` from ${at.toFixed(1)} s`}${encoder === null ? '' : `, picture through ${encoder}`})`)
      return {
        ok: true,
        stream: {
          live: plan.live,
          sound: urlOf('sound'),
          picture: pictureUrl === null ? null : { url: pictureUrl, live: true, offset: 0, encoder, shared: true },
          hasPicture: plan.hasPicture,
          duration: plan.duration
        }
      }
    }
    catch (err)
    {
      logger.warn(`Player could not stream ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`)
      return failure(err)
    }
  })

  ipcMain.handle('player:linkPicture', async (event, pageUrl: string, maxHeight: number, codecs?: VideoCodecFamily[], options?: { download?: boolean }): Promise<PlayerResult<'link'>> =>
  {
    const cap = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 1080
    const allowed = codecFamilies(codecs)
    const report = (progress: LinkProgress): void =>
    {
      if (!event.sender.isDestroyed())
      {
        event.sender.send('player:linkProgress', progress)
      }
    }
    try
    {
      const base = await startPreviewServer()
      report({ pageUrl, stage: 'resolving', percent: null })
      const direct = options?.download === true ? null : await getLinkVideo(pageUrl, cap, allowed)
      if (direct !== null)
      {
        return {
          ok: true,
          link: { kind: direct.kind, url: `${base}/${registerStreamProxy(direct.url, direct.httpHeaders)}`, width: direct.width, height: direct.height, codec: direct.codec, fps: direct.fps, hasSound: direct.hasSound }
        }
      }
      report({ pageUrl, stage: 'downloading', percent: 0 })
      const file = await downloadLinkVideo(pageUrl, cap, (percent) => report({ pageUrl, stage: 'downloading', percent }))
      return { ok: true, link: { kind: 'download', url: `${base}/${registerPreviewPath(file)}`, width: null, height: null, codec: 'h264', fps: null, hasSound: true } }
    }
    catch (err)
    {
      logger.warn(`Player could not get a picture for ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`)
      return failure(err)
    }
  })
}
