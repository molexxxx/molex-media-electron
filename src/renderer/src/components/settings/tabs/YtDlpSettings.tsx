/**
 * The yt-dlp section of Settings, Application, laid out like the Batch tab's sections: a legend, a lead, and rows
 * with the label on the left and the value or control on the right. It shows the version link playback runs and
 * where it comes from, when it was last checked, what its updater is doing, Check for updates, and the switch for
 * automatic updates, and the switch for "Use the yt-dlp found on this computer" with the version found on PATH, so
 * the choice is informed. A copy on PATH in use is reported as managed elsewhere and never updated. The
 * Application tab mounts it with the saved `ytdlpAutoUpdate` and `ytdlpUseSystem` settings and their change handlers.
 */
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { YtDlpStatus, YtDlpUpdateState } from '../../../../../shared/ipc/api'
import { formatBytes, formatDay } from '../../../copy/batch'
import { Banner } from '../../../ui/Banner'
import { Button } from '../../../ui/Button'
import { ProgressBar } from '../../../ui/ProgressBar'
import { Switch } from '../../../ui/Switch'

/** The words of the yt-dlp section. */
export const YTDLP_WORDS = {
  heading: 'yt-dlp',
  intro: 'Opens links from YouTube and other sites in the Player. Sites change often and stop working with an old yt-dlp, so molexMedia keeps its copy current.',
  loading: 'Reading yt-dlp.',
  unreadable: 'The yt-dlp status could not be read. Restart molexMedia, then open Settings again.',
  version: 'Version',
  updates: 'Updates',
  check: 'Check for updates',
  checking: 'Checking',
  updating: 'Updating',
  download: 'Download yt-dlp',
  downloading: 'Downloading',
  tryAgain: 'Try again',
  autoLabel: 'Update yt-dlp automatically',
  autoHint: 'Checks once a day in the background. Links keep working while it runs, and a new version takes over once no link is loading.',
  useSystemLabel: 'Use the yt-dlp found on this computer',
  useSystemNote: 'When this is on, molexMedia runs it and leaves updating it to the tool that installed it.',
  noneOnPath: 'No yt-dlp was found on PATH, so molexMedia uses its own copy.',
  missing: 'yt-dlp is not installed yet.',
  missingHint: 'molexMedia downloads it from the yt-dlp project on GitHub the first time you open a link, or now with Download yt-dlp.',
  managedHint: 'Update it with the tool that installed it, such as pip, Homebrew, or winget. molexMedia never changes it.',
  checkingLine: 'Checking for a new version.',
  upToDate: 'You have the latest version.'
} as const

/** Milliseconds in a day, for telling today and yesterday apart. */
const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(epochMs: number): number
{
  const date = new Date(epochMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** When the last check reached GitHub: "Last checked today.", "Last checked yesterday.", or "Last checked Oct 14." */
export function checkedWhen(lastCheckAt: number | null, now: number): string
{
  if (lastCheckAt === null)
  {
    return 'Not checked yet.'
  }
  const days = Math.round((startOfDay(now) - startOfDay(lastCheckAt)) / DAY_MS)
  if (days <= 0)
  {
    return 'Last checked today.'
  }
  return days === 1 ? 'Last checked yesterday.' : `Last checked ${formatDay(lastCheckAt)}.`
}

/** The version row's value: which yt-dlp runs and how it stays current. */
export function summaryLine(status: YtDlpStatus, autoUpdate: boolean): string
{
  if (!status.installed)
  {
    return YTDLP_WORDS.missing
  }
  const name = status.version === null ? 'yt-dlp' : `yt-dlp ${status.version}`
  if (status.source === 'system')
  {
    return `${name}, managed outside molexMedia.`
  }
  if (status.version === null)
  {
    return 'yt-dlp is installed, but it did not report its version.'
  }
  return autoUpdate ? `${name}, updated automatically.` : `${name}. Automatic updates are off.`
}

/** The line under it: where a copy on PATH is, the download for a missing copy, or when the app copy was checked. */
export function detailLine(status: YtDlpStatus, now: number): string
{
  if (status.source === 'system')
  {
    return `Found on PATH at ${status.path}. ${YTDLP_WORDS.managedHint}`
  }
  if (!status.installed)
  {
    const size = status.latest?.bytes
    return typeof size === 'number' ? `${YTDLP_WORDS.missingHint} The download is ${formatBytes(size)}.` : YTDLP_WORDS.missingHint
  }
  const when = checkedWhen(status.lastCheckAt, now)
  return status.version === null ? `${when} Check for updates to replace it.` : when
}

/** What the updater is doing, in words, or null when there is nothing to say; a failure shows as a banner instead. */
export function activityLine(status: YtDlpStatus): string | null
{
  const state = status.state
  switch (state.kind)
  {
    case 'checking':
      return YTDLP_WORDS.checkingLine
    case 'updating':
      if (state.phase === 'downloading')
      {
        return `Downloading yt-dlp ${state.version}.`
      }
      return state.phase === 'verifying'
        ? `Verifying yt-dlp ${state.version}.`
        : `yt-dlp ${state.version} is ready. It takes over as soon as no link is loading.`
    case 'up-to-date':
      return YTDLP_WORDS.upToDate
    case 'updated':
      return state.from === null ? `Installed yt-dlp ${state.to}.` : `Updated from ${state.from} to ${state.to}.`
    case 'idle':
      return status.source === 'app' && status.latest !== null && status.version !== null && status.latest.version !== status.version
        ? `yt-dlp ${status.latest.version} is available.`
        : null
    default:
      return null
  }
}

/** The failure banner's title and text, or null when nothing failed or the copy is managed elsewhere. */
export function failureNotice(status: YtDlpStatus): { title: string; text: string } | null
{
  const state = status.state
  if (state.kind !== 'failed' || status.source === 'system')
  {
    return null
  }
  if (!status.installed)
  {
    return { title: 'yt-dlp was not downloaded', text: state.reason }
  }
  const kept = status.version === null ? '' : ` molexMedia keeps using ${status.version}.`
  return { title: 'yt-dlp did not update', text: `${state.reason}${kept}` }
}

/** The hint under "Use the yt-dlp found on this computer": what PATH holds, with its version, or that it holds none. */
export function systemRowHint(status: Pick<YtDlpStatus, 'onPath'>): string
{
  if (status.onPath === null)
  {
    return YTDLP_WORDS.noneOnPath
  }
  const found = status.onPath.version === null
    ? `Found ${status.onPath.path}, but it did not report its version.`
    : `Found yt-dlp ${status.onPath.version} at ${status.onPath.path}.`
  return `${found} ${YTDLP_WORDS.useSystemNote}`
}

function isBusy(state: YtDlpUpdateState): boolean
{
  return state.kind === 'checking' || state.kind === 'updating'
}

/** The window's yt-dlp surface from the preload. */
interface YtDlpApi
{
  getYtDlpStatus: () => Promise<YtDlpStatus>
  checkYtDlpUpdates: (options?: { install?: boolean }) => Promise<YtDlpStatus>
  onYtDlpStatus: (cb: (status: YtDlpStatus) => void) => () => void
}

function ytDlpApi(): YtDlpApi | null
{
  const api = (window as unknown as { api?: Partial<YtDlpApi> }).api
  if (!api || typeof api.getYtDlpStatus !== 'function' || typeof api.checkYtDlpUpdates !== 'function' || typeof api.onYtDlpStatus !== 'function')
  {
    return null
  }
  return api as YtDlpApi
}

interface RowProps
{
  /** The label's id; the hint, when given, has `${id}-hint`. */
  id: string
  label: string
  /** Names a single control through `<label for>`. */
  htmlFor?: string
  hint?: string
  children: ReactNode
}

/** A settings row as the Batch tab draws it: the label and its hint on the left, the value or control on the right. */
function Row({ id, label, htmlFor, hint, children }: RowProps): ReactElement
{
  return (
    <div className='grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]'>
      <div className='flex min-w-0 flex-col gap-0.5'>
        {htmlFor === undefined
          ? <span id={id} className='text-body text-ink'>{label}</span>
          : <label id={id} htmlFor={htmlFor} className='text-body text-ink'>{label}</label>}
        {hint !== undefined && <p id={`${id}-hint`} className='text-label text-ink-3'>{hint}</p>}
      </div>
      <div className='flex min-w-0 flex-col gap-1.5'>{children}</div>
    </div>
  )
}

/** Props for {@link YtDlpSettings}. */
export interface YtDlpSettingsProps
{
  /** The saved `ytdlpAutoUpdate` setting as the tab holds it, so the switch answers at once. */
  autoUpdate: boolean
  /** Receives the switch's new value; the tab saves it as `ytdlpAutoUpdate`. */
  onAutoUpdateChange: (next: boolean) => void
  /** The saved `ytdlpUseSystem` setting as the tab holds it. */
  useSystem: boolean
  /** Receives the switch's new value; the tab saves it as `ytdlpUseSystem`. */
  onUseSystemChange: (next: boolean) => void
}

/** Settings, Application, yt-dlp: the version in use, its updates, and the two switches. */
export function YtDlpSettings({ autoUpdate, onAutoUpdateChange, useSystem, onUseSystemChange }: YtDlpSettingsProps): ReactElement
{
  const id = useId()
  const headingId = `${id}-title`
  const [status, setStatus] = useState<YtDlpStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [announce, setAnnounce] = useState('')
  const mounted = useRef(true)
  const pushed = useRef(false)

  useEffect(() =>
  {
    mounted.current = true
    const api = ytDlpApi()
    if (api === null)
    {
      setFailure(YTDLP_WORDS.unreadable)
      return undefined
    }
    const stop = api.onYtDlpStatus((next) =>
    {
      pushed.current = true
      if (mounted.current)
      {
        setStatus(next)
      }
    })
    api.getYtDlpStatus().then(
      (next) => mounted.current && !pushed.current && setStatus(next),
      () => mounted.current && setFailure(YTDLP_WORDS.unreadable)
    )
    return () =>
    {
      mounted.current = false
      stop()
    }
  }, [])

  async function runCheck(): Promise<void>
  {
    const api = ytDlpApi()
    if (api === null)
    {
      return
    }
    setRunning(true)
    setFailure(null)
    try
    {
      const next = await api.checkYtDlpUpdates()
      if (mounted.current)
      {
        setStatus(next)
        setAnnounce(failureNotice(next)?.title ?? activityLine(next) ?? summaryLine(next, autoUpdate))
      }
    }
    catch
    {
      if (mounted.current)
      {
        setFailure(YTDLP_WORDS.unreadable)
      }
    }
    finally
    {
      if (mounted.current)
      {
        setRunning(false)
      }
    }
  }

  const busy = running || (status !== null && isBusy(status.state))

  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-1 border-t border-line pt-5 first:border-t-0 first:pt-0'>
      <h2 id={headingId} className='type-legend text-accent-ink'>{YTDLP_WORDS.heading}</h2>
      <p className='text-label text-ink-2'>{YTDLP_WORDS.intro}</p>
      <p role='status' className='sr-only'>{announce}</p>
      {failure !== null && <Banner tone='error' title='yt-dlp' className='mt-2'>{failure}</Banner>}
      <div className='flex flex-col'>
        {status === null
          ? (failure === null && <p className='py-3 text-body text-ink-3'>{YTDLP_WORDS.loading}</p>)
          : (
            <StatusRows
              id={id}
              status={status}
              autoUpdate={autoUpdate}
              useSystem={useSystem}
              busy={busy}
              onCheck={() => void runCheck()}
              onAutoUpdateChange={onAutoUpdateChange}
              onUseSystemChange={onUseSystemChange}
            />
          )}
      </div>
    </section>
  )
}

interface StatusRowsProps
{
  id: string
  status: YtDlpStatus
  autoUpdate: boolean
  useSystem: boolean
  busy: boolean
  onCheck: () => void
  onAutoUpdateChange: (next: boolean) => void
  onUseSystemChange: (next: boolean) => void
}

/**
 * The version row, the updates row with its activity, failure, and action, the automatic update switch, and the
 * switch for the copy on PATH with what PATH holds. The updates row and the automatic switch apply only to the
 * app's copy, so they fold away while the copy on PATH is in use.
 */
function StatusRows({ id, status, autoUpdate, useSystem, busy, onCheck, onAutoUpdateChange, onUseSystemChange }: StatusRowsProps): ReactElement
{
  const notice = failureNotice(status)
  const activity = activityLine(status)
  const state = status.state
  const downloading = state.kind === 'updating' && state.phase === 'downloading' ? state : null
  const size = status.latest?.bytes
  const managedHere = status.source !== 'system'
  const autoId = `${id}-auto`
  const systemId = `${id}-system`
  const retry = (
    <Button variant='secondary' size='sm' icon='action.retry' disabled={busy} onClick={onCheck}>
      {YTDLP_WORDS.tryAgain}
    </Button>
  )
  return (
    <>
      <Row id={`${id}-version`} label={YTDLP_WORDS.version}>
        <p className='text-body text-ink'>{summaryLine(status, autoUpdate)}</p>
        <p className='wrap-break-word text-label text-ink-2'>{detailLine(status, Date.now())}</p>
      </Row>
      {managedHere && (
        <Row id={`${id}-updates`} label={YTDLP_WORDS.updates}>
          {notice !== null && (
            <Banner key={`${state.kind === 'failed' ? state.at : 0}`} tone='error' title={notice.title} actions={retry}>
              {notice.text}
            </Banner>
          )}
          {downloading !== null
            ? (
              <ProgressBar
                label={`Downloading yt-dlp ${downloading.version}`}
                value={downloading.totalBytes ? Math.min(1, downloading.receivedBytes / downloading.totalBytes) : undefined}
              />
            )
            : activity !== null && <p className='text-label text-ink-2'>{activity}</p>}
          <div className='flex flex-wrap gap-2'>
            {status.installed
              ? (
                <Button
                  variant='secondary'
                  icon='action.retry'
                  loading={busy}
                  loadingLabel={state.kind === 'updating' ? YTDLP_WORDS.updating : YTDLP_WORDS.checking}
                  onClick={onCheck}
                >
                  {YTDLP_WORDS.check}
                </Button>
              )
              : (
                <Button
                  variant='primary'
                  icon='action.export'
                  loading={busy}
                  loadingLabel={YTDLP_WORDS.downloading}
                  onClick={onCheck}
                >
                  {typeof size === 'number' ? `${YTDLP_WORDS.download} (${formatBytes(size)})` : YTDLP_WORDS.download}
                </Button>
              )}
          </div>
        </Row>
      )}
      {managedHere && (
        <Row id={`${id}-auto-label`} label={YTDLP_WORDS.autoLabel} htmlFor={autoId} hint={YTDLP_WORDS.autoHint}>
          <Switch id={autoId} describedBy={`${id}-auto-label-hint`} checked={autoUpdate} onChange={onAutoUpdateChange} className='self-start' />
        </Row>
      )}
      <Row id={`${id}-system-label`} label={YTDLP_WORDS.useSystemLabel} htmlFor={systemId} hint={systemRowHint(status)}>
        <Switch id={systemId} describedBy={`${id}-system-label-hint`} checked={useSystem} onChange={onUseSystemChange} className='self-start' />
      </Row>
    </>
  )
}
