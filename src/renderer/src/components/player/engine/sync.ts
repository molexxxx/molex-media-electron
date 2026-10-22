/**
 * Keeps the picture in step with the sound. The audio element is the clock: it feeds the visualizations and the
 * audio graph, and the muted video element follows it, nudged by its rate for small drift, moved for large drift,
 * and restarted at the clock's position when it is a conversion streamed while it plays, which cannot seek.
 */

/** The clock and the picture, both in source seconds. */
export interface SyncState
{
  master: number
  picture: number
  playing: boolean
  live: boolean
  /** The clock's playback rate. */
  rate: number
  /** True when the picture carries the clock's own times, so a picture ahead waits for the clock instead of restarting. */
  shared?: boolean
}

/** What the picture does next. */
export type SyncAction =
  | { kind: 'rate', rate: number }
  | { kind: 'seek', to: number }
  | { kind: 'restart', at: number }
  | { kind: 'hold' }

/** The drift limits, in seconds, and the most the rate is nudged. */
export const SYNC_LIMITS = Object.freeze({
  /** Drift the eye cannot see; the picture runs at the clock's rate. */
  tolerance: 0.04,
  /** Beyond this a seekable picture jumps to the clock. */
  seekBeyond: 0.6,
  /** A live picture this far ahead pauses until the clock reaches it. */
  liveHold: 0.25,
  /** A live picture this far off restarts at the clock, since a rate nudge would take too long to catch up. */
  liveRestart: 1,
  /** A picture on the clock's own times waits this far ahead for the clock before it restarts instead. */
  sharedHold: 8,
  /** The largest rate change, as a fraction of the clock's rate. */
  maxNudge: 0.08,
  /** The rate change per second of drift. */
  gain: 0.5
})

function clamp(value: number, low: number, high: number): number
{
  return Math.min(high, Math.max(low, value))
}

/** The picture's next step for one moment of drift. */
export function syncAction(state: SyncState): SyncAction
{
  const drift = state.picture - state.master
  if (state.live && state.shared === true && drift > SYNC_LIMITS.liveHold && drift <= SYNC_LIMITS.sharedHold)
  {
    return { kind: 'hold' }
  }
  if (state.live)
  {
    if (Math.abs(drift) > SYNC_LIMITS.liveRestart)
    {
      return { kind: 'restart', at: state.master }
    }
    if (drift > SYNC_LIMITS.liveHold)
    {
      return { kind: 'hold' }
    }
  }
  else if (Math.abs(drift) > SYNC_LIMITS.seekBeyond)
  {
    return { kind: 'seek', to: state.master }
  }
  if (Math.abs(drift) <= SYNC_LIMITS.tolerance)
  {
    return { kind: 'rate', rate: state.rate }
  }
  const nudge = clamp(-drift * SYNC_LIMITS.gain, -SYNC_LIMITS.maxNudge, SYNC_LIMITS.maxNudge)
  return { kind: 'rate', rate: state.rate * (1 + nudge) }
}

/** The picture source the follower plays: a URL, whether it is a live conversion, and the source time it starts at. */
export interface FollowSource
{
  url: string
  live: boolean
  offset: number
  /** The encoder of a picture FFmpeg decodes; null or absent when Chromium reads the stream. */
  encoder?: string | null
  /** True when the picture carries the clock's own times, as a link stream does, so they are compared as they are. */
  shared?: boolean
}

/** What the follower reads from the clock. */
export interface Clock
{
  /** Source seconds. */
  time(): number
  playing(): boolean
  rate(): number
}

/**
 * Resolves once the picture can play (true), or fails to load or the wait runs out (false), so a stream's sound can
 * start with it and a picture that never arrived can be started again.
 */
export function whenPlayable(video: HTMLMediaElement, timeoutMs: number): Promise<boolean>
{
  if (video.readyState >= 3)
  {
    return Promise.resolve(true)
  }
  return new Promise((resolve) =>
  {
    const finish = (playable: boolean): void =>
    {
      clearTimeout(timer)
      video.removeEventListener('canplay', ready)
      video.removeEventListener('error', failed)
      resolve(playable)
    }
    const ready = (): void => finish(true)
    const failed = (): void => finish(false)
    const timer = setTimeout(failed, timeoutMs)
    video.addEventListener('canplay', ready)
    video.addEventListener('error', failed)
  })
}

/** The lead a restarted conversion starts ahead of the clock, learned from how long the last start took. */
export const START_LEAD = Object.freeze({ initial: 1, min: 0.4, max: 4 })

/**
 * A muted video element that follows a clock. `restart` asks the owner for a new live source starting at a source
 * time; the owner answers by calling {@link PictureFollower.load}. The follower never touches the clock.
 */
export class PictureFollower
{
  private source: FollowSource | null = null
  private lead = 0
  private holding = false
  private restartRequested = 0
  private startLead: number = START_LEAD.initial
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly onLoadedData = (): void =>
  {
    const video = this.video
    this.lead = this.source?.live && this.source.shared !== true && video.buffered.length > 0 ? video.buffered.start(0) : 0
    if (this.restartRequested > 0)
    {
      const took = (performance.now() - this.restartRequested) / 1000
      this.startLead = clamp(took + 0.3, START_LEAD.min, START_LEAD.max)
      this.restartRequested = 0
    }
    this.follow()
  }

  constructor(private readonly video: HTMLVideoElement, private readonly clock: Clock, private readonly restart: (at: number) => void)
  {
    video.muted = true
    video.addEventListener('loadeddata', this.onLoadedData)
  }

  /** The source playing, or null. */
  current(): FollowSource | null
  {
    return this.source
  }

  /** Plays a new source and starts following. */
  load(source: FollowSource): void
  {
    this.source = source
    this.lead = 0
    this.holding = false
    this.video.muted = true
    this.video.src = source.url
    this.video.load()
    if (this.timer === null)
    {
      this.timer = setInterval(() => this.follow(), 250)
    }
  }

  /** Stops the picture and releases its source, which also ends a live conversion. */
  clear(): void
  {
    this.source = null
    this.holding = false
    if (this.timer !== null)
    {
      clearInterval(this.timer)
      this.timer = null
    }
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }

  /** Detaches from the element for good. */
  dispose(): void
  {
    this.clear()
    this.video.removeEventListener('loadeddata', this.onLoadedData)
  }

  /** The picture's position in source seconds. */
  pictureTime(): number
  {
    return this.video.currentTime - this.lead + (this.source?.offset ?? 0)
  }

  /** The clock jumped: a seekable picture follows at once, a live one restarts ahead of it. */
  seekTo(time: number): void
  {
    const source = this.source
    if (source === null)
    {
      return
    }
    if (source.live)
    {
      this.requestRestart(time)
      return
    }
    this.video.currentTime = Math.max(0, time - source.offset)
  }

  /** Mirrors the clock's play and pause, and corrects drift; called on clock events and four times a second. */
  follow(): void
  {
    const source = this.source
    const video = this.video
    if (source === null || video.readyState < 2)
    {
      return
    }
    const playing = this.clock.playing()
    const action = syncAction({ master: this.clock.time(), picture: this.pictureTime(), playing, live: source.live, rate: this.clock.rate(), shared: source.shared === true })
    switch (action.kind)
    {
      case 'restart':
        this.requestRestart(action.at)
        return
      case 'seek':
        video.currentTime = Math.max(0, action.to - source.offset)
        break
      case 'hold':
        this.holding = true
        video.pause()
        return
      case 'rate':
        this.holding = false
        if (Math.abs(video.playbackRate - action.rate) > 0.001)
        {
          video.playbackRate = action.rate
        }
        break
    }
    if (playing && video.paused && !this.holding)
    {
      video.play().catch(() => undefined)
    }
    else if (!playing && !video.paused)
    {
      video.pause()
    }
  }

  private requestRestart(at: number): void
  {
    if (this.restartRequested > 0 && performance.now() - this.restartRequested < 1500)
    {
      return
    }
    this.restartRequested = performance.now()
    const ahead = this.clock.playing() ? this.startLead : 0
    this.restart(at + ahead)
  }
}
