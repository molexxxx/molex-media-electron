/**
 * @module components/setup/SetupWizard
 * @description First-run setup: downloads the tested FFmpeg build, checks its SHA-256, and shows its self-test.
 *
 * Steps: Welcome (Download FFmpeg, I have it), Downloading (progress), Complete (the build and its self-test,
 * Get started), and Error (the reason, Retry, I have it).
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { FfmpegInfo } from '../../../../shared/ipc/api'
import { megabytes } from '../../../../shared/jobs/describe'
import { useAppStore } from '../../stores/appStore'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { ProgressBar } from '../../ui/ProgressBar'
import { selfTestResult, testedWhen } from '../settings/tabs/AudioSettings'

type Step = 'welcome' | 'downloading' | 'complete' | 'error'

/** The wizard's words. */
export const SETUP_WORDS = {
  title: 'Welcome to molexMedia',
  need: 'molexMedia needs FFmpeg to read, measure, and write media.',
  folder: 'It goes into the app data folder; nothing else on your system changes.',
  test: 'A self-test runs on it before any job starts.',
  download: 'Download FFmpeg',
  have: 'I have it',
  settingUp: 'Setting up FFmpeg',
  wait: 'This takes a minute or two, depending on your connection.',
  doneTitle: 'FFmpeg is installed',
  start: 'Get started',
  failedTitle: 'Download failed',
  manual: 'You can install FFmpeg yourself and add it to PATH, then choose I have it.',
  retry: 'Retry',
  license: 'FFmpeg is licensed under the LGPL or GPL. molexMedia downloads it from its publishers\' releases.',
  unknownError: 'The download stopped for an unknown reason.'
} as const

/** The consequence line: "Downloads FFmpeg 9.0.2, about 194 MB, and checks its SHA-256." */
export function setupLine(version: string | null, bytes: number | null): string
{
  if (version === null)
  {
    return 'Downloads FFmpeg and checks its SHA-256.'
  }
  return bytes === null
    ? `Downloads FFmpeg ${version} and checks its SHA-256.`
    : `Downloads FFmpeg ${version}, about ${megabytes(bytes)}, and checks its SHA-256.`
}

/** The download size of the pinned build for this platform, when the build information carries it. */
export function pinBytes(pin: FfmpegInfo['pin']): number | null
{
  return 'downloadBytes' in pin && typeof pin.downloadBytes === 'number' ? pin.downloadBytes : null
}

/** The self-test result of an installed build as one line: "Self-test passed, Oct 20, 11:02, in 1.4 s". */
export function selfTestLine(info: FfmpegInfo): { tone: 'passed' | 'failed' | 'not-run'; text: string }
{
  const result = selfTestResult(info.selfTest)
  const when = testedWhen(info.selfTest.testedAt, info.selfTest.durationMs)
  const head = `Self-test ${result.text.charAt(0).toLowerCase()}${result.text.slice(1)}`
  return { tone: result.tone, text: when === null ? `${head}.` : `${head}, ${when}.` }
}

const TONE_INK = { 'passed': 'text-verified', 'failed': 'text-error', 'not-run': 'text-ink-2' } as const
const TONE_ICON = { 'passed': 'status.verified', 'failed': 'status.failed', 'not-run': 'status.pending' } as const

async function readInfo(): Promise<FfmpegInfo | null>
{
  try
  {
    return await window.api.getFFmpegInfo()
  }
  catch
  {
    return null
  }
}

/** The first-run wizard shown while no usable FFmpeg is installed. */
export default function SetupWizard(): ReactElement
{
  const { setFFmpegReady, setShowSetup, setConfig, downloadProgress, setDownloadProgress } = useAppStore()
  const [step, setStep] = useState<Step>('welcome')
  const [error, setError] = useState('')
  const [info, setInfo] = useState<FfmpegInfo | null>(null)

  useEffect(() =>
  {
    let live = true
    void readInfo().then((next) => live && next !== null && setInfo(next))
    return () =>
    {
      live = false
    }
  }, [])

  async function handleDownload(): Promise<void>
  {
    setStep('downloading')
    setError('')
    try
    {
      const result = await window.api.downloadFFmpeg()
      if (result.success)
      {
        const next = await readInfo()
        if (next !== null)
        {
          setInfo(next)
        }
        setStep('complete')
        setFFmpegReady(true, next?.version ?? result.version)
        setConfig(await window.api.loadConfig())
      }
      else
      {
        setError(result.error || SETUP_WORDS.unknownError)
        setStep('error')
      }
    }
    catch (err)
    {
      setError(err instanceof Error ? err.message : SETUP_WORDS.unknownError)
      setStep('error')
    }
  }

  async function handleSkip(): Promise<void>
  {
    const result = await window.api.checkFFmpeg()
    if (result.found)
    {
      const next = await readInfo()
      setFFmpegReady(true, next?.version ?? result.version)
      setConfig(await window.api.loadConfig())
      setShowSetup(false)
    }
  }

  function handleDone(): void
  {
    setShowSetup(false)
    setDownloadProgress(null)
  }

  const consequence = setupLine(info?.pin.version ?? null, info === null ? null : pinBytes(info.pin))

  return (
    <div className='flex flex-1 items-center justify-center bg-ground p-8'>
      <div className='flex w-full max-w-lg flex-col gap-6'>
        <div className='flex flex-col gap-1 border-b border-line pb-4'>
          <h1 className='type-title text-ink'>{SETUP_WORDS.title}</h1>
          <p className='text-body text-ink-2'>{consequence}</p>
        </div>

        {step === 'welcome' && (
          <div className='flex flex-col gap-5'>
            <div className='flex flex-col gap-2 text-body'>
              <p className='text-ink'>{SETUP_WORDS.need}</p>
              <p className='text-ink-2'>{SETUP_WORDS.folder}</p>
              <p className='text-ink-2'>{SETUP_WORDS.test}</p>
            </div>
            <div className='flex gap-2'>
              <Button variant='primary' icon='action.export' onClick={() => void handleDownload()} className='flex-1'>{SETUP_WORDS.download}</Button>
              <Button variant='ghost' onClick={() => void handleSkip()}>{SETUP_WORDS.have}</Button>
            </div>
          </div>
        )}

        {step === 'downloading' && (
          <div className='flex flex-col gap-3' aria-busy='true'>
            <h2 className='text-section text-ink'>{downloadProgress?.message || SETUP_WORDS.settingUp}</h2>
            <p className='text-body text-ink-2'>{SETUP_WORDS.wait}</p>
            <ProgressBar
              tone='meter'
              size='md'
              label={downloadProgress?.message || SETUP_WORDS.settingUp}
              value={downloadProgress ? downloadProgress.percent / 100 : undefined}
            />
          </div>
        )}

        {step === 'complete' && (
          <div className='flex flex-col gap-5'>
            <div className='flex flex-col gap-2'>
              <h2 className='flex items-center gap-2 text-section text-ink'>
                <span className='text-verified'><Icon name='status.verified' size='md' /></span>
                {info?.version ? `${SETUP_WORDS.doneTitle}: ${info.version}` : SETUP_WORDS.doneTitle}
              </h2>
              {info !== null && <SelfTestResult info={info} />}
            </div>
            <Button variant='primary' onClick={handleDone} className='w-full'>{SETUP_WORDS.start}</Button>
          </div>
        )}

        {step === 'error' && (
          <div className='flex flex-col gap-5'>
            <div className='flex flex-col gap-2'>
              <h2 className='flex items-center gap-2 text-section text-ink'>
                <span className='text-error'><Icon name='status.failed' size='md' /></span>
                {SETUP_WORDS.failedTitle}
              </h2>
              <p role='alert' className='select-text text-body text-ink'>{error}</p>
              <p className='text-body text-ink-2'>{SETUP_WORDS.manual}</p>
            </div>
            <div className='flex gap-2'>
              <Button variant='primary' icon='action.retry' onClick={() => void handleDownload()} className='flex-1'>{SETUP_WORDS.retry}</Button>
              <Button variant='ghost' onClick={() => void handleSkip()}>{SETUP_WORDS.have}</Button>
            </div>
          </div>
        )}

        <p className='text-label text-ink-3'>{SETUP_WORDS.license}</p>
      </div>
    </div>
  )
}

/** The installed build's self-test result, and the reason jobs cannot start when it is not ready. */
function SelfTestResult({ info }: { info: FfmpegInfo }): ReactElement
{
  const line = selfTestLine(info)
  return (
    <div className='flex flex-col gap-1'>
      <p className={`flex items-center gap-2 text-body ${TONE_INK[line.tone]}`}>
        <Icon name={TONE_ICON[line.tone]} size='sm' />
        <span className='tabular-nums'>{line.text}</span>
      </p>
      {info.refusal !== null && <p className='text-body text-ink-2'>{`FFmpeg is not ready: ${info.refusal}. Jobs cannot start.`}</p>}
    </div>
  )
}
