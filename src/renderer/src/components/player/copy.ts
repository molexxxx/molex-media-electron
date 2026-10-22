/**
 * The Player's words, in one place so the page, the pop-out, and the tests read the same text.
 */

import type { VisMode } from '../../visualizations/types'
import type { PictureQuality, SoundQuality } from './engine/links'

/** Region and control names. */
export const PLAYER_COPY = Object.freeze({
  page: 'Player',
  stage: 'Picture and visualization',
  playlist: 'Playlist',
  transport: 'Playback controls',
  addFiles: 'Add files',
  addFolder: 'Add folder…',
  addFilesMore: 'add files',
  addLink: 'Add link',
  visualization: 'Visualization',
  video: 'Video',
  view: 'Show',
  fullScreen: 'Full screen',
  exitFullScreen: 'Leave full screen',
  popOut: 'Pop out',
  popOutLong: 'Pop out the player into a small window that stays on top',
  more: 'More player options',
  mediaInfo: 'Media information',
  shortcuts: 'Keyboard shortcuts',
  showPlaylist: 'Show playlist',
  hidePlaylist: 'Hide playlist',
  play: 'Play',
  pause: 'Pause',
  previous: 'Previous',
  next: 'Next',
  shuffle: 'Shuffle',
  mute: 'Mute',
  unmute: 'Unmute',
  volume: 'Volume',
  seek: 'Position',
  audioTrack: 'Audio track',
  subtitles: 'Subtitles',
  subtitlesOff: 'Off',
  soundQuality: 'Link sound quality',
  pictureQuality: 'Link picture quality',
  emptyHeading: 'Add files or a link to start listening',
  emptyLine: 'Drop audio or video files anywhere on this page. Links play through yt-dlp, from YouTube and many other sites.',
  dropLine: 'Drop to add to the playlist',
  dropHint: 'Files and folders add their media; a link adds what it points to.',
  poppedOutHeading: 'Playing in the pop-out window',
  poppedOutLine: 'Close the pop-out, or choose Back to the app there, to bring the player back here.',
  bringBack: 'Bring the player back',
  nothingPlaying: 'Nothing playing',
  playlistEmpty: 'The playlist is empty.',
  clear: 'Clear playlist',
  clearQuestion: 'Remove every track from the playlist?',
  clearConfirm: 'Clear',
  keep: 'Keep',
  remove: 'Remove from playlist',
  playNow: 'Play',
  showInFolder: 'Show in folder',
  copyLink: 'Copy link',
  copied: 'Link copied.',
  dismiss: 'Dismiss',
  details: 'What the tool said',
  linkHeading: 'Add a link',
  linkLabel: 'Link',
  linkPlaceholder: 'https://www.youtube.com/watch?v=…',
  linkHint: 'A video, a playlist, or a direct link to a media file.',
  linkAdd: 'Add',
  linkAdding: 'Reading…',
  linkStop: 'Stop waiting',
  linkRecent: 'Recent links',
  linkForget: 'Forget',
  gettingSound: 'Getting the sound stream through yt-dlp…',
  downloadingSound: 'Downloading the sound through yt-dlp…',
  gettingPicture: 'Getting the picture through yt-dlp…',
  downloadingPicture: 'Downloading the video',
  soundDownloaded: 'Sound downloaded first; this stream could not be played directly.',
  noPicture: 'This link has no picture the player can show, so the visualization shows instead.',
  pictureFailed: 'The picture could not be prepared, so the visualization shows instead.',
  pictureStopped: 'The picture stopped playing, so the visualization shows instead.',
  pictureDownloaded: 'Video downloaded first; this stream could not be played directly.',
  live: 'Live',
  liveSeek: 'Position (a live stream cannot be moved)',
  startingStream: 'Starting the stream through FFmpeg…',
  startingLive: 'Starting the live stream through FFmpeg…',
  liveFailed: 'This live stream could not be played. It may have ended, or the site refused the request. Try again later.',
  streamDownloaded: 'Sound downloaded first; the stream could not be played as it arrived.',
  pictureBehind: 'The picture kept falling behind the sound, so the visualization shows instead.',
  windowSize: 'Window size',
  rememberSize: 'Remember this size',
  keepOnTop: 'Keep on top',
  stopKeepingOnTop: 'Stop keeping on top',
  backToApp: 'Back to the app',
  minimize: 'Minimize',
  close: 'Close',
  noSound: 'This file has no sound.'
})

/** The visualizations' names, in menu order. */
export const VIS_NAMES: Readonly<Record<VisMode, string>> = {
  dmt: 'DMT',
  space: 'Space',
  milkdrop: 'Milkdrop',
  plasma: 'Plasma',
  bars: 'Bars',
  wave: 'Waveform',
  horizon: 'Horizon',
  rain: 'Rain'
}

/** The link sound qualities, best first. */
export const SOUND_QUALITY_NAMES: Readonly<Record<SoundQuality, string>> = { best: 'Best', good: 'Good (160 kb/s or less)', low: 'Low (smallest)' }

/** The link picture qualities. */
export const PICTURE_QUALITY_NAMES: Readonly<Record<PictureQuality, string>> = { auto: 'Auto (fits the screen)', '1080p': '1080p', '720p': '720p', '480p': '480p' }

/** The repeat button's name for each mode, which is also its state. */
export const REPEAT_NAMES = Object.freeze({ off: 'Repeat: off', all: 'Repeat: all tracks', one: 'Repeat: this track' })

/** "4 tracks · 12:31", with "+" when a length is still unknown; "1 track" for one. */
export function playlistSummary(count: number, total: string, complete: boolean): string
{
  const tracks = count === 1 ? '1 track' : `${count.toLocaleString('en-US')} tracks`
  return count === 0 ? tracks : `${tracks} · ${total}${complete ? '' : '+'}`
}

/** "Volume 80 percent" for the slider's spoken value. */
export function volumeText(volume: number): string
{
  return `${Math.round(volume * 100)} percent`
}
