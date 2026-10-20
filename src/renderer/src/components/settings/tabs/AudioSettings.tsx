/**
 * The FFmpeg section of Settings: the build in use (version, source, libsoxr, minimum), its self-test result and
 * time, Re-run self-test, and Install the tested build when a bundled build differs from this version's pin. There
 * are no loudness or encoding settings here; every job carries its own operation and preset.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { FfmpegBuildSource, FfmpegInfo, FfmpegInstallResult, FfmpegSelfTestId } from '../../../../../shared/ipc/api'
import { formatDay, formatTimeOfDay } from '../../../copy/batch'
import { useAppStore } from '../../../stores/appStore'
import { Banner } from '../../../ui/Banner'
import { Button } from '../../../ui/Button'
import { Icon } from '../../../ui/Icon'
import { ProgressBar } from '../../../ui/ProgressBar'

/** The words of the FFmpeg section. */
export const FFMPEG_WORDS = {
  heading: 'FFmpeg',
  intro: 'Every job runs with this FFmpeg build. Jobs start only while it meets the minimum version and passes its self-test.',
  loading: 'Reading the FFmpeg build.',
  version: 'Version',
  source: 'Source',
  location: 'Location',
  soxr: 'libsoxr',
  minimum: 'Minimum version',
  selfTest: 'Self-test',
  rerun: 'Re-run self-test',
  rerunning: 'Running self-test',
  installing: 'Installing FFmpeg',
  details: 'Self-test details',
  notFound: 'Not found',
  yes: 'Yes',
  no: 'No',
  met: 'Met',
  unreadable: 'The FFmpeg build could not be read.'
} as const

const SOURCE_LABELS: Readonly<Record<FfmpegBuildSource, string>> =
{
  bundled: 'Installed by molexMedia',
  path: 'Found on PATH',
  custom: 'Chosen by you'
}

/** What each self-test checks, in plain words. */
export const SELF_TEST_LABELS: Readonly<Record<FfmpegSelfTestId, string>> =
{
  'chain-flac-s16': 'Stereo limiter chain to 16-bit FLAC',
  'chain-opus-51side': '5.1 limiter chain to Opus',
  'chain-aac-mono': 'Mono limiter chain to AAC',
  'meter-dual-mono': 'Dual-mono loudness meter',
  'meter-surround': 'Surround loudness meter',
  'soxr': 'SoX resampler',
  'encoders': 'Required encoders'
}

/** Where the build came from, or "Not found". */
export function sourceLabel(source: FfmpegBuildSource | null): string
{
  return source === null ? FFMPEG_WORDS.notFound : SOURCE_LABELS[source]
}

/** When a self-test ran and how long it took: "Oct 20, 11:02, in 1.4 s". */
export function testedWhen(testedAt: number | null, durationMs: number | null): string | null
{
  if (testedAt === null)
  {
    return null
  }
  const when = `${formatDay(testedAt)}, ${formatTimeOfDay(testedAt)}`
  return durationMs === null ? when : `${when}, in ${(durationMs / 1000).toFixed(1)} s`
}

/** The self-test result as one line: "Passed", "Failed: SoX resampler", or "Not run". */
export function selfTestResult(selfTest: FfmpegInfo['selfTest']): { tone: 'passed' | 'failed' | 'not-run'; text: string }
{
  if (selfTest.status === 'passed')
  {
    return { tone: 'passed', text: 'Passed' }
  }
  if (selfTest.status === 'failed')
  {
    return { tone: 'failed', text: selfTest.failedTest === null ? 'Failed' : `Failed: ${SELF_TEST_LABELS[selfTest.failedTest]}` }
  }
  return { tone: 'not-run', text: 'Not run' }
}

/** What a failed surround meter test means for jobs, or null when it passed or the self-test did not run. */
export function surroundMeterNote(selfTest: FfmpegInfo['selfTest']): string | null
{
  const ran = selfTest.status === 'passed' || selfTest.status === 'failed'
  if (!ran || selfTest.results === null || selfTest.results['meter-surround'])
  {
    return null
  }
  return 'This build measures surround loudness incorrectly, so Normalize and Gain do not run on surround files. Stereo and mono files are not affected.'
}

/** Whether the minimum version is met, or why not. */
export function minimumLine(info: Pick<FfmpegInfo, 'found' | 'meetsMinimum' | 'refusal'>): string
{
  if (!info.found)
  {
    return FFMPEG_WORDS.notFound
  }
  return info.meetsMinimum ? FFMPEG_WORDS.met : 'Below the minimum version'
}

/** Whether to offer the tested build: a bundled build differs from the pin, or no FFmpeg was found. */
export function offersInstall(info: Pick<FfmpegInfo, 'found' | 'pin'>): boolean
{
  return info.pin.offerInstall || !info.found
}

/** The window's FFmpeg surface from the preload. */
interface FfmpegApi
{
  getFFmpegInfo: () => Promise<FfmpegInfo>
  rerunFFmpegSelfTest: () => Promise<FfmpegInfo>
  installPinnedFFmpeg: () => Promise<FfmpegInstallResult>
  onDownloadProgress: (cb: (progress: { stage?: string; message?: string; percent?: number }) => void) => () => void
}

function ffmpegApi(): FfmpegApi | null
{
  return (window as unknown as { api?: FfmpegApi }).api ?? null
}

const TONE_INK = { 'passed': 'text-verified', 'failed': 'text-error', 'not-run': 'text-ink-2' } as const
const TONE_ICON = { 'passed': 'status.verified', 'failed': 'status.failed', 'not-run': 'status.pending' } as const

/** One fact of the build: a label and its value. */
function Fact({ label, children }: { label: string; children: ReactElement | string }): ReactElement
{
  return (
    <div className='grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-4 border-b border-line py-1.5 last:border-b-0'>
      <dt className='text-label text-ink-2'>{label}</dt>
      <dd className='min-w-0 text-body text-ink'>{children}</dd>
    </div>
  )
}

/** Each self-test with its result, folded under a toggle. */
function SelfTestDetails({ results }: { results: Record<FfmpegSelfTestId, boolean> }): ReactElement
{
  const [open, setOpen] = useState(false)
  const regionId = useId()
  return (
    <div className='flex flex-col items-start gap-1'>
      <Button
        variant='ghost'
        size='sm'
        icon={open ? 'action.collapse' : 'action.expand'}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className='-ms-2'
      >
        {FFMPEG_WORDS.details}
      </Button>
      <ul id={regionId} hidden={!open} aria-label={FFMPEG_WORDS.details} className='flex flex-col gap-0.5'>
        {(Object.keys(SELF_TEST_LABELS) as FfmpegSelfTestId[]).map((id) => (
          <li key={id} className='flex items-center gap-2 text-label text-ink-2'>
            <span className={results[id] ? 'text-verified' : 'text-error'}>
              <Icon name={results[id] ? 'status.verified' : 'status.failed'} size='sm' />
            </span>
            <span>{SELF_TEST_LABELS[id]}</span>
            <span className='text-ink-3'>{results[id] ? 'passed' : 'failed'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Settings, FFmpeg: the build in use, its self-test, and the tested build to install. */
export function FfmpegSettings(): ReactElement
{
  const headingId = useId()
  const setFFmpegReady = useAppStore((state) => state.setFFmpegReady)
  const [info, setInfo] = useState<FfmpegInfo | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<'rerun' | 'install' | null>(null)
  const [progress, setProgress] = useState<{ message: string; percent: number } | null>(null)
  const [announce, setAnnounce] = useState('')
  const mounted = useRef(true)

  useEffect(() =>
  {
    mounted.current = true
    const api = ffmpegApi()
    if (api === null)
    {
      setFailure(FFMPEG_WORDS.unreadable)
      return undefined
    }
    api.getFFmpegInfo().then(
      (next) => mounted.current && setInfo(next),
      () => mounted.current && setFailure(FFMPEG_WORDS.unreadable)
    )
    return () =>
    {
      mounted.current = false
    }
  }, [])

  function apply(next: FfmpegInfo): void
  {
    setInfo(next)
    setFFmpegReady(next.usable, next.version ?? undefined)
  }

  async function rerun(): Promise<void>
  {
    const api = ffmpegApi()
    if (api === null)
    {
      return
    }
    setBusy('rerun')
    setFailure(null)
    try
    {
      const next = await api.rerunFFmpegSelfTest()
      apply(next)
      setAnnounce(`Self-test ${selfTestResult(next.selfTest).text.toLowerCase()}.`)
    }
    catch
    {
      setFailure(FFMPEG_WORDS.unreadable)
    }
    finally
    {
      setBusy(null)
    }
  }

  async function install(): Promise<void>
  {
    const api = ffmpegApi()
    if (api === null)
    {
      return
    }
    setBusy('install')
    setFailure(null)
    setProgress({ message: FFMPEG_WORDS.installing, percent: 0 })
    const stop = api.onDownloadProgress((update) =>
    {
      setProgress({ message: update.message ?? FFMPEG_WORDS.installing, percent: update.percent ?? 0 })
    })
    try
    {
      const result = await api.installPinnedFFmpeg()
      apply(result.info)
      if (result.ok)
      {
        setAnnounce(`Installed FFmpeg ${result.info.version ?? ''}. Self-test ${selfTestResult(result.info.selfTest).text.toLowerCase()}.`)
      }
      else
      {
        setFailure(result.error)
      }
    }
    catch (error)
    {
      setFailure(error instanceof Error ? error.message : FFMPEG_WORDS.unreadable)
    }
    finally
    {
      stop()
      setProgress(null)
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <h2 id={headingId} className='type-legend text-brass'>{FFMPEG_WORDS.heading}</h2>
        <p className='text-body text-ink-2'>{FFMPEG_WORDS.intro}</p>
      </div>
      <p role='status' className='sr-only'>{announce}</p>
      {failure !== null && <Banner tone='error' title='FFmpeg'>{failure}</Banner>}
      {info === null
        ? (failure === null && <p className='text-body text-ink-3'>{FFMPEG_WORDS.loading}</p>)
        : <BuildFacts info={info} busy={busy} progress={progress} onRerun={() => void rerun()} onInstall={() => void install()} />}
    </section>
  )
}

interface BuildFactsProps
{
  info: FfmpegInfo
  busy: 'rerun' | 'install' | null
  progress: { message: string; percent: number } | null
  onRerun: () => void
  onInstall: () => void
}

/** The build's facts, its readiness, and the section's actions. */
function BuildFacts({ info, busy, progress, onRerun, onInstall }: BuildFactsProps): ReactElement
{
  const result = selfTestResult(info.selfTest)
  const when = testedWhen(info.selfTest.testedAt, info.selfTest.durationMs)
  const surround = surroundMeterNote(info.selfTest)
  return (
    <>
      {info.refusal !== null && (
        <Banner tone='warning' title='FFmpeg is not ready'>{`FFmpeg is not ready: ${info.refusal}. Jobs cannot start.`}</Banner>
      )}
      <dl className='flex flex-col rounded-sm border border-line bg-panel px-3 py-1'>
        <Fact label={FFMPEG_WORDS.version}>
          <span className='tabular-nums'>{info.version ?? FFMPEG_WORDS.notFound}</span>
        </Fact>
        <Fact label={FFMPEG_WORDS.source}>{sourceLabel(info.source)}</Fact>
        {info.ffmpegPath !== null && (
          <Fact label={FFMPEG_WORDS.location}>
            <span className='block truncate select-text' title={info.ffmpegPath}>{info.ffmpegPath}</span>
          </Fact>
        )}
        <Fact label={FFMPEG_WORDS.soxr}>{info.libsoxr ? FFMPEG_WORDS.yes : FFMPEG_WORDS.no}</Fact>
        <Fact label={FFMPEG_WORDS.minimum}>{minimumLine(info)}</Fact>
        <Fact label={FFMPEG_WORDS.selfTest}>
          <span className='flex flex-col gap-1'>
            <span className={`flex items-center gap-2 ${TONE_INK[result.tone]}`}>
              <Icon name={TONE_ICON[result.tone]} size='sm' />
              <span>{result.text}</span>
              {when !== null && <span className='tabular-nums text-label text-ink-3'>{when}</span>}
            </span>
            {surround !== null && (
              <span className='flex items-start gap-2 text-label text-warning'>
                <Icon name='status.warning' size='sm' />
                <span>{surround}</span>
              </span>
            )}
            {info.selfTest.results !== null && <SelfTestDetails results={info.selfTest.results} />}
          </span>
        </Fact>
      </dl>
      {progress !== null && (
        <ProgressBar tone='meter' label={progress.message} value={progress.percent / 100} />
      )}
      <div className='flex flex-wrap gap-2'>
        {offersInstall(info) && (
          <Button variant='primary' icon='action.export' loading={busy === 'install'} loadingLabel={FFMPEG_WORDS.installing} disabled={busy !== null} onClick={onInstall}>
            {info.pin.installLabel}
          </Button>
        )}
        <Button
          variant='secondary'
          icon='action.retry'
          loading={busy === 'rerun'}
          loadingLabel={FFMPEG_WORDS.rerunning}
          disabled={busy !== null || !info.found}
          onClick={onRerun}
        >
          {FFMPEG_WORDS.rerun}
        </Button>
      </div>
    </>
  )
}
