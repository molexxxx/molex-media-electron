/**
 * @module components/setup/SetupWizard
 * @description First-run setup in the main window: what molexMedia does, what it needs and why, the tested FFmpeg
 * download with lit percent, size, and speed readouts, plain errors with Retry, an FFmpeg already on this computer
 * chosen by folder and self-tested like discovery does, and a done screen that opens Batch or the Dashboard.
 */
import { useEffect, useId, useReducer, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { FfmpegDownloadFacts, FfmpegFolderResult, FfmpegInfo, FfmpegInstallResult, SetupProblem, WindowApi, YtDlpStatus } from '../../../../shared/ipc/api'
import { listenUnclaimedKeys } from '../../hooks/useAppZoomKeys'
import { useAppStore } from '../../stores/appStore'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { usePlatform } from '../../ui/Kbd'
import { ProgressBar } from '../../ui/ProgressBar'
import { StatusLabel } from '../../ui/StatusLabel'
import { selfTestResult, surroundMeterNote, testedWhen } from '../settings/tabs/AudioSettings'
import {
  SETUP_WORDS,
  STAGE_WORDS,
  downloadReadouts,
  ffmpegSourceLine,
  ffmpegStep,
  folderOf,
  foundLine,
  offerLine,
  problemOfError,
  problemWords,
  rateOf,
  refusalWords,
  sourceWords,
  ytDlpLine,
  type FfmpegStep,
  type ProblemWords
} from './setupFlow'

type SetupApi = Pick<WindowApi, 'getFFmpegInfo' | 'installPinnedFFmpeg' | 'onDownloadProgress' | 'loadConfig'>
  & Partial<Pick<WindowApi, 'getFFmpegDownloadFacts' | 'chooseFFmpegFolder' | 'adoptFFmpegFolder' | 'getYtDlpStatus' | 'onYtDlpStatus'>>

function setupApi(): SetupApi | null
{
  return (window as unknown as { api?: SetupApi }).api ?? null
}

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [contenteditable="true"]'

/** The first-run setup shown while no usable FFmpeg is installed. */
export default function SetupWizard(): ReactElement
{
  const { setFFmpegReady, setShowSetup, setConfig, setDownloadProgress, setView } = useAppStore()
  const platform = usePlatform()
  const [step, dispatch] = useReducer(ffmpegStep, { kind: 'idle' })
  const [found, setFound] = useState<FfmpegInfo | null>(null)
  const [facts, setFacts] = useState<FfmpegDownloadFacts | null>(null)
  const [ytdlp, setYtdlp] = useState<YtDlpStatus | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [announce, setAnnounce] = useState('')
  const primaryRef = useRef<HTMLButtonElement>(null)
  const live = useRef(true)

  useEffect(() =>
  {
    live.current = true
    const api = setupApi()
    let stopYtdlp: (() => void) | undefined
    if (api !== null)
    {
      api.getFFmpegInfo().then((next) => live.current && setFound(next), () => undefined)
      api.getFFmpegDownloadFacts?.().then((next) => live.current && setFacts(next), () => undefined)
      api.getYtDlpStatus?.().then((next) => live.current && setYtdlp(next), () => undefined)
      stopYtdlp = api.onYtDlpStatus?.((next) => setYtdlp(next))
    }
    return () =>
    {
      live.current = false
      stopYtdlp?.()
    }
  }, [])

  const done = step.kind === 'ready'

  useEffect(() =>
  {
    primaryRef.current?.focus()
  }, [done])

  async function finish(info: FfmpegInfo): Promise<void>
  {
    dispatch({ type: 'ready', info })
    setFFmpegReady(true, info.version ?? undefined)
    setAnnounce(`molexMedia is ready. FFmpeg ${info.version ?? ''} ${selfTestResult(info.selfTest).text.toLowerCase()} its self-test.`)
    const api = setupApi()
    if (api !== null)
    {
      try
      {
        setConfig(await api.loadConfig())
      }
      catch
      {
        return
      }
    }
  }

  function fail(problem: SetupProblem): void
  {
    setDetailsOpen(false)
    dispatch({ type: 'fail', problem })
    setAnnounce(`${problemWords(problem).title}.`)
  }

  async function install(): Promise<void>
  {
    const api = setupApi()
    if (api === null || step.kind === 'installing' || step.kind === 'checking-folder')
    {
      return
    }
    dispatch({ type: 'install' })
    setDetailsOpen(false)
    setAnnounce('Downloading FFmpeg.')
    const stop = api.onDownloadProgress((progress) => dispatch({ type: 'progress', progress, at: performance.now() }))
    let result: FfmpegInstallResult
    try
    {
      result = await api.installPinnedFFmpeg()
    }
    catch (error)
    {
      fail(problemOfError(error))
      return
    }
    finally
    {
      stop()
      setDownloadProgress(null)
    }
    if (!result.ok)
    {
      fail(result.problem ?? problemOfError(result.error))
      return
    }
    if (!result.info.usable)
    {
      fail({ kind: 'rejected', status: null, detail: result.info.refusal ?? '' })
      return
    }
    await finish(result.info)
  }

  async function useExisting(chosen?: string): Promise<void>
  {
    const api = setupApi()
    if (api?.chooseFFmpegFolder === undefined || api.adoptFFmpegFolder === undefined || step.kind === 'installing' || step.kind === 'checking-folder')
    {
      return
    }
    const folder = chosen ?? await api.chooseFFmpegFolder()
    if (folder === null)
    {
      return
    }
    setDetailsOpen(false)
    dispatch({ type: 'check-folder', folder })
    setAnnounce('Checking the FFmpeg in that folder.')
    let result: FfmpegFolderResult
    try
    {
      result = await api.adoptFFmpegFolder(folder)
    }
    catch (error)
    {
      fail(problemOfError(error))
      return
    }
    if (result.status === 'adopted')
    {
      await finish(result.info)
      return
    }
    dispatch({ type: 'refuse', folder: result.folder, reason: result.reason, version: result.version, failedTest: result.failedTest })
    setAnnounce(`${refusalWords(result, platform).title}.`)
  }

  function open(view: 'batch' | 'dashboard'): void
  {
    setView(view)
    setDownloadProgress(null)
    setShowSetup(false)
  }

  useEffect(() => listenUnclaimedKeys((event) =>
  {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector('dialog[open]'))
    {
      return
    }
    const target = event.target instanceof Element ? event.target : null
    if (event.key === 'Enter' && target?.closest(INTERACTIVE) == null)
    {
      event.preventDefault()
      primaryRef.current?.click()
    }
    else if (event.key === 'Escape')
    {
      setDetailsOpen(false)
      primaryRef.current?.focus()
    }
  }), [])

  const offer = found?.pathBuild ?? null
  const offered = offer !== null && step.kind !== 'refused'

  return (
    <div className='flex min-h-0 flex-1 flex-col overflow-y-auto bg-ground'>
      <div className='mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 pt-[min(12vh,7rem)] pb-12'>
        <p role='status' className='sr-only'>{announce}</p>
        {step.kind === 'ready'
          ? <DoneScreen info={step.info} ytdlp={ytdlp} primaryRef={primaryRef} onOpen={open} />
          : (
            <>
              <header className='flex flex-col gap-2'>
                <h1 className='type-display text-ink'>{SETUP_WORDS.title}</h1>
                <p className='text-section font-normal text-ink-2'>{SETUP_WORDS.pitch}</p>
              </header>
              <section aria-labelledby='setup-needs' className='flex flex-col gap-3'>
                <h2 id='setup-needs' className='text-section text-ink'>{SETUP_WORDS.needsHeading}</h2>
                <ul className='flex flex-col rounded-sm border border-line bg-panel'>
                  <FfmpegRow
                    step={step}
                    found={found}
                    facts={facts}
                    platform={platform}
                    detailsOpen={detailsOpen}
                    onToggleDetails={() => setDetailsOpen(!detailsOpen)}
                  />
                  <YtDlpRow />
                </ul>
                <p className='text-label text-ink-3'>{`${SETUP_WORDS.folderNote} ${SETUP_WORDS.license}`}</p>
              </section>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  ref={primaryRef}
                  variant='primary'
                  icon={step.kind === 'failed' ? 'action.retry' : 'action.export'}
                  loading={step.kind === 'installing'}
                  loadingLabel={SETUP_WORDS.downloading}
                  unavailableReason={step.kind === 'checking-folder' ? 'Wait until the folder check finishes.' : undefined}
                  onClick={() => void install()}
                >
                  {step.kind === 'failed' ? SETUP_WORDS.retry : SETUP_WORDS.download}
                </Button>
                <Button
                  variant='secondary'
                  icon='action.browse'
                  loading={step.kind === 'checking-folder'}
                  loadingLabel={SETUP_WORDS.checkingFolder}
                  unavailableReason={step.kind === 'installing' ? 'Wait until the download finishes.' : undefined}
                  onClick={() => void useExisting(offered ? folderOf(offer.ffmpegPath) : undefined)}
                >
                  {offered ? SETUP_WORDS.useFound : step.kind === 'refused' ? SETUP_WORDS.chooseAnother : SETUP_WORDS.useExisting}
                </Button>
                {offered && (
                  <Button
                    variant='ghost'
                    unavailableReason={step.kind === 'installing' || step.kind === 'checking-folder' ? 'Wait until the current step finishes.' : undefined}
                    onClick={() => void useExisting()}
                  >
                    {SETUP_WORDS.chooseFolder}
                  </Button>
                )}
              </div>
            </>
          )}
      </div>
    </div>
  )
}

interface FfmpegRowProps
{
  step: FfmpegStep
  found: FfmpegInfo | null
  facts: FfmpegDownloadFacts | null
  platform: string
  detailsOpen: boolean
  onToggleDetails: () => void
}

/** FFmpeg: what it is for, its size and source, and where its install or folder check stands. */
function FfmpegRow({ step, found, facts, platform, detailsOpen, onToggleDetails }: FfmpegRowProps): ReactElement
{
  const source = ffmpegSourceLine(facts)
  const note = step.kind === 'idle' ? foundLine(found) : null
  const offer = (step.kind === 'idle' || step.kind === 'failed') && found?.pathBuild ? offerLine(found.pathBuild) : null
  return (
    <li className='flex flex-col gap-2 border-b border-line px-4 py-3'>
      <div className='flex items-baseline gap-3'>
        <span className='text-section text-ink'>{SETUP_WORDS.ffmpeg}</span>
        {found !== null && <span className='text-body text-ink-2 tabular-nums'>{found.pin.version}</span>}
        <span className='ms-auto'><FfmpegStatus step={step} /></span>
      </div>
      <div className='flex flex-col gap-1'>
        <p className='text-body text-ink'>{SETUP_WORDS.ffmpegPurpose}</p>
        <p className='text-label text-ink-2'>{source === null ? SETUP_WORDS.ffmpegCheck : `${source} ${SETUP_WORDS.ffmpegCheck}`}</p>
        {note !== null && (
          <p className='flex items-start gap-2 text-label text-warning'>
            <Icon name='status.warning' size='sm' />
            <span>{note}</span>
          </p>
        )}
        {offer !== null && (
          <p className='flex items-start gap-2 text-label text-ink-2'>
            <span className='text-verified'><Icon name='status.verified' size='sm' /></span>
            <span className='min-w-0 break-words'>{offer}</span>
          </p>
        )}
      </div>
      {step.kind === 'installing' && <InstallProgress step={step} />}
      {step.kind === 'checking-folder' && (
        <div className='flex flex-col gap-2'>
          <ProgressBar tone='meter' label='Checking FFmpeg' showValue={false} />
          <p className='flex min-w-0 items-baseline gap-2 text-label text-ink-2'>
            <span className='shrink-0'>Running the self-test on</span>
            <span className='min-w-0 truncate font-mono text-ink' title={step.folder}>{step.folder}</span>
          </p>
        </div>
      )}
      {step.kind === 'failed' && (
        <Problem words={problemWords(step.problem)} detail={step.problem.detail} detailsOpen={detailsOpen} onToggleDetails={onToggleDetails} />
      )}
      {step.kind === 'refused' && <Problem words={refusalWords(step, platform)} folder={step.folder} />}
    </li>
  )
}

/** The FFmpeg row's status at its right edge. */
function FfmpegStatus({ step }: { step: FfmpegStep }): ReactElement
{
  switch (step.kind)
  {
    case 'installing':
      return <StatusLabel status='encoding' label={STAGE_WORDS[step.stage]} />
    case 'checking-folder':
      return <StatusLabel status='verifying' label='Checking' />
    case 'failed':
      return <StatusLabel status='failed' label='Not installed' />
    case 'refused':
      return <StatusLabel status='failed' label='Not used' />
    default:
      return <span className='text-label text-ink-3'>{SETUP_WORDS.required}</span>
  }
}

/** The download bar with its lit readouts, then the stage after it and the checksum result. */
function InstallProgress({ step }: { step: Extract<FfmpegStep, { kind: 'installing' }> }): ReactElement
{
  const downloading = step.stage === 'downloading'
  const readouts = downloadReadouts({ percent: step.percent, received: step.received, total: step.total, rate: rateOf(step.samples) })
  const spoken = readouts.map((readout) => readout.spoken).join(', ')
  return (
    <div className='flex flex-col gap-2'>
      <ProgressBar
        tone='meter'
        label={`${STAGE_WORDS[step.stage]} FFmpeg`}
        value={downloading ? step.percent / 100 : undefined}
        valueText={downloading ? spoken : STAGE_WORDS[step.stage]}
        showValue={false}
      />
      {downloading
        ? (
          <dl className='flex flex-wrap items-baseline gap-x-6 gap-y-1' aria-label='Download'>
            {readouts.map((readout) => (
              <div key={readout.key} className='flex items-baseline gap-1.5' data-readout={readout.key}>
                <dt className='sr-only'>{readout.key === 'percent' ? 'Done' : readout.key === 'size' ? 'Received' : 'Speed'}</dt>
                <dd className='flex items-baseline gap-1.5'>
                  <span className='type-readout text-[1.125rem] leading-6 font-semibold'>{readout.value}</span>
                  {readout.unit !== '' && <span className='text-label text-ink-3'>{readout.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )
        : <p className='text-label text-ink-2'>{`${STAGE_WORDS[step.stage]}.`}</p>}
      {step.verified && step.stage !== 'downloading' && (
        <p className='flex items-center gap-2 text-label text-verified'>
          <Icon name='status.verified' size='sm' />
          <span>{SETUP_WORDS.verified}</span>
        </p>
      )}
    </div>
  )
}

interface ProblemProps
{
  words: ProblemWords
  folder?: string
  detail?: string
  detailsOpen?: boolean
  onToggleDetails?: () => void
}

/** A stopped download or a refused folder: the problem, the way out, and the original message folded away. */
function Problem({ words, folder, detail, detailsOpen = false, onToggleDetails }: ProblemProps): ReactElement
{
  const detailsId = useId()
  return (
    <div role='alert' className='flex flex-col gap-1'>
      <p className='flex items-start gap-2 text-body font-semibold text-ink'>
        <span className='mt-0.5 text-error'><Icon name='status.failed' size='sm' /></span>
        <span>{words.title}</span>
      </p>
      <p className='ps-5.5 text-body text-ink-2'>{words.body}</p>
      {folder !== undefined && (
        <p className='ps-5.5 min-w-0 truncate font-mono text-label text-ink-3 select-text' title={folder}>{folder}</p>
      )}
      {detail !== undefined && detail !== '' && onToggleDetails !== undefined && (
        <div className='flex flex-col items-start gap-1 ps-5.5'>
          <Button
            variant='ghost'
            size='sm'
            icon={detailsOpen ? 'action.collapse' : 'action.expand'}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={onToggleDetails}
            className='-ms-2'
          >
            {SETUP_WORDS.details}
          </Button>
          <p id={detailsId} hidden={!detailsOpen} className='font-mono text-label text-ink-2 select-text break-all'>{detail}</p>
        </div>
      )}
    </div>
  )
}

/** yt-dlp: what it is for and when it arrives. */
function YtDlpRow(): ReactElement
{
  return (
    <li className='flex flex-col gap-2 px-4 py-3'>
      <div className='flex items-baseline gap-3'>
        <span className='text-section text-ink'>{SETUP_WORDS.ytdlp}</span>
        <span className='ms-auto text-label text-ink-3'>{SETUP_WORDS.whenNeeded}</span>
      </div>
      <div className='flex flex-col gap-1'>
        <p className='text-body text-ink'>{SETUP_WORDS.ytdlpPurpose}</p>
        <p className='text-label text-ink-2'>{SETUP_WORDS.ytdlpWhen}</p>
      </div>
    </li>
  )
}

/** The done screen's first line: what molexMedia will run jobs with. */
export function doneLine(info: Pick<FfmpegInfo, 'version' | 'source'>): string
{
  const version = info.version === null ? 'FFmpeg' : `FFmpeg ${info.version}`
  return info.source === 'bundled'
    ? `${version} is installed and passed its self-test.`
    : `molexMedia will use ${version}, which passed its self-test.`
}

interface DoneScreenProps
{
  info: FfmpegInfo
  /** The yt-dlp copy in use, or null while unknown. */
  ytdlp: YtDlpStatus | null
  primaryRef: RefObject<HTMLButtonElement | null>
  onOpen: (view: 'batch' | 'dashboard') => void
}

/** Setup is finished: the build, its self-test, the yt-dlp in use, and where to go next. */
function DoneScreen({ info, ytdlp, primaryRef, onOpen }: DoneScreenProps): ReactElement
{
  const result = selfTestResult(info.selfTest)
  const when = testedWhen(info.selfTest.testedAt, info.selfTest.durationMs)
  const surround = surroundMeterNote(info.selfTest)
  return (
    <>
      <header className='flex flex-col gap-2'>
        <h1 className='flex items-center gap-3 type-display text-ink'>
          <span className='text-verified'><Icon name='status.verified' size='lg' /></span>
          {SETUP_WORDS.doneTitle}
        </h1>
        <p className='text-section font-normal text-ink-2'>{doneLine(info)}</p>
      </header>
      <dl className='flex flex-col rounded-sm border border-line bg-panel px-4 py-1'>
        <DoneFact label={SETUP_WORDS.ffmpeg}>
          <span className='flex flex-wrap items-baseline gap-x-2'>
            <span className='tabular-nums text-ink'>{info.version ?? ''}</span>
            <span className='text-ink-2'>{sourceWords(info.source)}</span>
          </span>
        </DoneFact>
        <DoneFact label='Self-test'>
          <span className='flex flex-col gap-1'>
            <span className={`flex items-center gap-2 ${result.tone === 'passed' ? 'text-verified' : 'text-error'}`}>
              <Icon name={result.tone === 'passed' ? 'status.verified' : 'status.failed'} size='sm' />
              <span>{result.text}</span>
              {when !== null && <span className='tabular-nums text-label text-ink-3'>{when}</span>}
            </span>
            {surround !== null && (
              <span className='flex items-start gap-2 text-label text-warning'>
                <Icon name='status.warning' size='sm' />
                <span>{surround}</span>
              </span>
            )}
          </span>
        </DoneFact>
        <DoneFact label={SETUP_WORDS.ytdlp}>
          <span className='text-ink-2'>{ytDlpLine(ytdlp)}</span>
        </DoneFact>
      </dl>
      <div className='flex flex-wrap items-center gap-2'>
        <Button ref={primaryRef} variant='primary' icon='nav.batch' onClick={() => onOpen('batch')}>{SETUP_WORDS.openBatch}</Button>
        <Button variant='secondary' icon='nav.dashboard' onClick={() => onOpen('dashboard')}>{SETUP_WORDS.openDashboard}</Button>
      </div>
    </>
  )
}

/** One fact of the done screen: a label and its value. */
function DoneFact({ label, children }: { label: string; children: ReactElement }): ReactElement
{
  return (
    <div className='grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-4 border-b border-line py-2 last:border-b-0'>
      <dt className='text-label text-ink-2'>{label}</dt>
      <dd className='min-w-0 text-body'>{children}</dd>
    </div>
  )
}
