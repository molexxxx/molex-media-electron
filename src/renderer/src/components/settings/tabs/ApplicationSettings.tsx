/**
 * The Application section of Settings: app updates with the yt-dlp section under them, what the close button does
 * and how the window opens, interface size and spoken batch progress, the browser YouTube cookies come from, the
 * project page, and the reset to defaults. Each switch and choice writes its config key through Settings' debounced
 * save; the update actions go to the updater, whose status the app store follows.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { CookieBrowser, CookieInfo } from '../../../../../shared/ipc/api'
import { countOf } from '../../../copy/batch'
import { useAppStore, type AppConfig } from '../../../stores/appStore'
import { Button, InlineConfirm, ProgressBar, Select, Switch, type SelectOption } from '../../../ui'
import { Row, Section } from '../Section'
import { YtDlpSettings } from './YtDlpSettings'

/** The words of the Application section. */
export const APPLICATION_WORDS = {
  updates: 'Updates',
  updatesLead: 'molexMedia looks for new versions on GitHub Releases. Nothing downloads or installs until you choose to.',
  autoLabel: 'Check for updates when molexMedia starts',
  autoHint: 'Looks once, a few seconds after launch. A version you can download shows in the sidebar.',
  check: 'Check for updates',
  checking: 'Checking',
  downloading: 'Downloading',
  install: 'Install and restart',
  latest: 'You have the latest version.',
  available: 'A new version is available.',
  ready: 'Update ready. Installing restarts molexMedia.',
  manual: 'This copy is updated by your package manager, or with the latest .deb or .rpm from GitHub Releases.',
  checkFailed: 'The update check did not finish.',
  downloadFailed: 'The download did not finish.',
  window: 'Window',
  windowLead: 'What the close button does and how the window opens.',
  trayLabel: 'Minimize to the tray instead of quitting',
  trayHint: 'The close button hides molexMedia in the system tray, and a running batch carries on. Restore it from the tray icon, or quit from the tray menu.',
  askLabel: 'Ask before closing',
  askHint: 'Each time you close the window, choose between minimizing to the tray and quitting.',
  sidebarLabel: 'Start with the sidebar collapsed',
  sidebarHint: 'Opens with the sidebar as a narrow rail of icons. Expand or collapse it any time from the sidebar.',
  accessibility: 'Accessibility',
  sizeLabel: 'Interface size',
  sizeHint: 'Scales text and controls in every window. Ctrl+Plus and Ctrl+Minus change it for this session; Ctrl+0 returns to this size.',
  announceLabel: 'Announce batch progress every 30 seconds',
  announceHint: 'While a batch runs and focus is in Batch, a screen reader hears how many jobs finished and the time left, when the counts change.',
  cookies: 'YouTube cookies',
  cookiesLead: 'Age-restricted and private videos play only with the login cookies of a browser you are signed in to. yt-dlp exports them once, and molexMedia keeps the copy for 7 days.',
  browserLabel: 'Browser',
  browserHint: 'Detect automatically tries the browsers installed on this computer and keeps the first one that works.',
  autoDetect: 'Detect automatically',
  cancel: 'Cancel',
  continue: 'Continue',
  exported: 'Cookies exported.',
  exportFailed: 'The cookies could not be exported.',
  savedLabel: 'Saved cookies',
  none: 'None yet. They are exported on the first YouTube link that needs them.',
  clear: 'Clear cookies',
  about: 'About',
  aboutLead: 'A media processing toolkit powered by FFmpeg.',
  projectLabel: 'Project page',
  projectHint: 'Release notes, the source code, and where to report a problem.',
  openGitHub: 'Open GitHub',
  defaults: 'Defaults',
  resetLabel: 'Reset app settings',
  resetHint: 'Restores the Application and Batch settings to the values a new install starts with. Presets, history, recent folders, and FFmpeg stay.',
  reset: 'Reset settings',
  resetQuestion: 'Reset the Application and Batch settings to their defaults?',
  resetConfirm: 'Reset',
  keep: 'Keep'
} as const

/** The project's page on GitHub. */
export const PROJECT_URL = 'https://github.com/molexxxx/molex-media-electron'

/** The Interface size choices in percent; main clamps the stored value to 90 to 200. */
export const INTERFACE_SIZES = [90, 100, 110, 125, 150, 175, 200] as const

/** The Select value that stands for an empty `ytdlpBrowser`, since a Select value is never the empty string. */
export const AUTO_BROWSER = 'auto'

/** The Interface size options, with a stored size outside the list kept as its own choice. */
export function interfaceSizeOptions(current: number): SelectOption[]
{
  const sizes: number[] = [...INTERFACE_SIZES]
  if (Number.isFinite(current) && !sizes.includes(current))
  {
    sizes.push(current)
    sizes.sort((a, b) => a - b)
  }
  return sizes.map((size) => ({ value: String(size), label: `${size}%` }))
}

type UpdateStatus = ReturnType<typeof useAppStore.getState>['updateStatus']

/** What the update row reports after a check, or null while there is nothing to report or the bar shows progress. */
export function updateLine(status: UpdateStatus, version: string | null): string | null
{
  switch (status)
  {
    case 'up-to-date':
      return APPLICATION_WORDS.latest
    case 'available':
      return version === null ? APPLICATION_WORDS.available : `molexMedia ${version} is available.`
    case 'downloaded':
      return APPLICATION_WORDS.ready
    case 'manual':
      return APPLICATION_WORDS.manual
    default:
      return null
  }
}

/** The message of an install the updater held back or could not start, or null when it went ahead. */
export function installRefusal(result: unknown): string | null
{
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== false) return null
  const message = (result as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}

/** How long ago, in plain words: "less than a minute ago", "12 minutes ago", "3 hours ago", "2 days ago". */
export function agoWords(ms: number | null): string
{
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'some time ago'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${countOf(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${countOf(hours, 'hour')} ago`
  return `${countOf(Math.floor(hours / 24), 'day')} ago`
}

/** The saved cookies row's hint: when and from which browser they were exported, or that there are none yet. */
export function cookiesLine(info: CookieInfo | null, browsers: readonly CookieBrowser[]): string
{
  if (info === null || !info.exists) return APPLICATION_WORDS.none
  const from = info.browser ? ` from ${browserLabel(browsers, info.browser)}` : ''
  return `Exported ${agoWords(info.age)}${from}. Exported again after 7 days.`
}

/** A browser's label, or its name while the list has not loaded. */
export function browserLabel(browsers: readonly CookieBrowser[], name: string): string
{
  return browsers.find((browser) => browser.name === name)?.label ?? name
}

/** Props for {@link ApplicationSettings}. */
export interface ApplicationSettingsProps
{
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onResetDefaults: () => void
}

type Update = ApplicationSettingsProps['onUpdate']

function UpdatesSection({ config, onUpdate }: { config: AppConfig; onUpdate: Update }): ReactElement
{
  const base = useId()
  const updateStatus = useAppStore((s) => s.updateStatus)
  const updateVersion = useAppStore((s) => s.updateVersion)
  const updateError = useAppStore((s) => s.updateError)
  const downloadPercent = useAppStore((s) => s.updateDownloadPercent)
  const setUpdateStatus = useAppStore((s) => s.setUpdateStatus)
  const setUpdateError = useAppStore((s) => s.setUpdateError)
  const [refusal, setRefusal] = useState<string | null>(null)

  async function checkNow(): Promise<void>
  {
    setRefusal(null)
    setUpdateStatus('checking')
    setUpdateError(null)
    const result = await window.api.checkForUpdates()
    if (!result.success && result.error)
    {
      setUpdateStatus('error')
      setUpdateError(result.error)
    }
  }

  async function downloadNow(): Promise<void>
  {
    setRefusal(null)
    const result = await window.api.downloadUpdate()
    if (!result.success)
    {
      setUpdateStatus('error')
      setUpdateError(result.error || APPLICATION_WORDS.downloadFailed)
    }
  }

  async function installNow(): Promise<void>
  {
    setRefusal(installRefusal(await window.api.installUpdate()))
  }

  const line = refusal ?? updateLine(updateStatus, updateVersion)
  const error = updateStatus === 'error' ? updateError ?? APPLICATION_WORDS.checkFailed : undefined
  let action: ReactElement
  if (updateStatus === 'downloaded')
  {
    action = <Button variant="primary" icon="action.export" onClick={() => void installNow()}>{APPLICATION_WORDS.install}</Button>
  }
  else if (updateStatus === 'available' || updateStatus === 'downloading')
  {
    action = (
      <Button variant="primary" icon="action.export" loading={updateStatus === 'downloading'} loadingLabel={APPLICATION_WORDS.downloading} onClick={() => void downloadNow()}>
        {updateVersion === null ? 'Download' : `Download ${updateVersion}`}
      </Button>
    )
  }
  else
  {
    action = (
      <Button icon="action.retry" loading={updateStatus === 'checking'} loadingLabel={APPLICATION_WORDS.checking} onClick={() => void checkNow()}>
        {APPLICATION_WORDS.check}
      </Button>
    )
  }

  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.updates} lead={APPLICATION_WORDS.updatesLead}>
      <Row id={`${base}-auto`} label={APPLICATION_WORDS.autoLabel} htmlFor={`${base}-auto-switch`} hint={APPLICATION_WORDS.autoHint}>
        <Switch id={`${base}-auto-switch`} describedBy={`${base}-auto-hint`} checked={config.autoUpdate} onChange={(next) => onUpdate('autoUpdate', next)} />
      </Row>
      <Row id={`${base}-version`} label={`molexMedia ${__APP_VERSION__}`} error={error}>
        <div className="flex flex-wrap items-center gap-3">
          {action}
          <p role="status" className="text-label text-ink-2 empty:hidden">{line ?? ''}</p>
        </div>
        {updateStatus === 'downloading' && (
          <ProgressBar label={updateVersion === null ? 'Downloading the update' : `Downloading molexMedia ${updateVersion}`} value={downloadPercent / 100} className="max-w-sm" />
        )}
      </Row>
    </Section>
  )
}

function WindowSection({ config, onUpdate }: { config: AppConfig; onUpdate: Update }): ReactElement
{
  const base = useId()
  const setTray = (next: boolean): void =>
  {
    onUpdate('minimizeToTray', next)
    if (!next) onUpdate('showTrayNotification', false)
  }
  const setSidebar = (next: boolean): void =>
  {
    onUpdate('sidebarCollapsed', next)
    useAppStore.setState({ sidebarCollapsed: next })
  }
  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.window} lead={APPLICATION_WORDS.windowLead}>
      <Row id={`${base}-tray`} label={APPLICATION_WORDS.trayLabel} htmlFor={`${base}-tray-switch`} hint={APPLICATION_WORDS.trayHint}>
        <Switch id={`${base}-tray-switch`} describedBy={`${base}-tray-hint`} checked={config.minimizeToTray} onChange={setTray} />
      </Row>
      {config.minimizeToTray && (
        <Row id={`${base}-ask`} label={APPLICATION_WORDS.askLabel} htmlFor={`${base}-ask-switch`} hint={APPLICATION_WORDS.askHint}>
          <Switch id={`${base}-ask-switch`} describedBy={`${base}-ask-hint`} checked={config.showTrayNotification} onChange={(next) => onUpdate('showTrayNotification', next)} />
        </Row>
      )}
      <Row id={`${base}-sidebar`} label={APPLICATION_WORDS.sidebarLabel} htmlFor={`${base}-sidebar-switch`} hint={APPLICATION_WORDS.sidebarHint}>
        <Switch id={`${base}-sidebar-switch`} describedBy={`${base}-sidebar-hint`} checked={config.sidebarCollapsed ?? false} onChange={setSidebar} />
      </Row>
    </Section>
  )
}

/** Props for {@link AccessibilityGroup}. */
export interface AccessibilityGroupProps
{
  interfaceScale: number
  announceProgress: boolean
  onUpdate: Update
}

/** Interface size for every window and the opt-in spoken batch progress. */
export function AccessibilityGroup({ interfaceScale, announceProgress, onUpdate }: AccessibilityGroupProps): ReactElement
{
  const base = useId()
  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.accessibility}>
      <Row id={`${base}-size`} label={APPLICATION_WORDS.sizeLabel} htmlFor={`${base}-size-select`} hint={APPLICATION_WORDS.sizeHint}>
        <Select
          id={`${base}-size-select`}
          describedBy={`${base}-size-hint`}
          value={String(interfaceScale)}
          options={interfaceSizeOptions(interfaceScale)}
          onChange={(value) => onUpdate('interfaceScale', Number(value))}
          className="w-28"
        />
      </Row>
      <Row id={`${base}-announce`} label={APPLICATION_WORDS.announceLabel} htmlFor={`${base}-announce-switch`} hint={APPLICATION_WORDS.announceHint}>
        <Switch id={`${base}-announce-switch`} describedBy={`${base}-announce-hint`} checked={announceProgress} onChange={(next) => onUpdate('announceProgress', next)} />
      </Row>
    </Section>
  )
}

type CookieStep =
  | { kind: 'idle' }
  | { kind: 'confirming'; browser: string }
  | { kind: 'exporting'; browser: string }
  | { kind: 'exported' }
  | { kind: 'failed'; message: string }

function CookiesSection({ config, onUpdate }: { config: AppConfig; onUpdate: Update }): ReactElement
{
  const base = useId()
  const [browsers, setBrowsers] = useState<CookieBrowser[]>([])
  const [info, setInfo] = useState<CookieInfo | null>(null)
  const [step, setStep] = useState<CookieStep>({ kind: 'idle' })
  const mounted = useRef(true)

  useEffect(() =>
  {
    mounted.current = true
    window.api.getInstalledBrowsers?.().then((list) => mounted.current && setBrowsers(list)).catch(() => undefined)
    window.api.getCookieInfo?.().then((next) => mounted.current && setInfo(next)).catch(() => undefined)
    return () =>
    {
      mounted.current = false
    }
  }, [])

  function choose(value: string): void
  {
    if (value === AUTO_BROWSER)
    {
      onUpdate('ytdlpBrowser', '')
      setStep({ kind: 'idle' })
      return
    }
    setStep({ kind: 'confirming', browser: value })
  }

  async function exportFrom(browser: string): Promise<void>
  {
    setStep({ kind: 'exporting', browser })
    try
    {
      const result = await window.api.setCookieBrowser(browser)
      if (!mounted.current) return
      if (result.success)
      {
        onUpdate('ytdlpBrowser', browser)
        setStep({ kind: 'exported' })
        window.api.getCookieInfo?.().then((next) => mounted.current && setInfo(next)).catch(() => undefined)
      }
      else
      {
        setStep({ kind: 'failed', message: result.error || APPLICATION_WORDS.exportFailed })
      }
    }
    catch (error)
    {
      if (mounted.current) setStep({ kind: 'failed', message: error instanceof Error && error.message ? error.message : APPLICATION_WORDS.exportFailed })
    }
  }

  async function clear(): Promise<void>
  {
    await window.api.clearCookies()
    if (!mounted.current) return
    onUpdate('ytdlpBrowser', '')
    setInfo({ exists: false, age: null, browser: '' })
    setStep({ kind: 'idle' })
  }

  const options: SelectOption[] = [
    { value: AUTO_BROWSER, label: APPLICATION_WORDS.autoDetect },
    ...browsers.map((browser) => ({ value: browser.name, label: browser.label }))
  ]
  const status = step.kind === 'exporting'
    ? `Exporting cookies from ${browserLabel(browsers, step.browser)}.`
    : step.kind === 'exported' ? APPLICATION_WORDS.exported : null

  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.cookies} lead={APPLICATION_WORDS.cookiesLead}>
      <Row id={`${base}-browser`} label={APPLICATION_WORDS.browserLabel} htmlFor={`${base}-browser-select`} hint={APPLICATION_WORDS.browserHint} error={step.kind === 'failed' ? step.message : undefined}>
        <Select
          id={`${base}-browser-select`}
          describedBy={`${base}-browser-hint`}
          value={config.ytdlpBrowser || AUTO_BROWSER}
          options={options}
          disabled={step.kind === 'exporting'}
          onChange={choose}
          className="w-64"
        />
        {step.kind === 'confirming' && (
          <InlineConfirm
            question={`Close ${browserLabel(browsers, step.browser)}, then continue. yt-dlp can read its cookies only while the browser is closed.`}
            safeLabel={APPLICATION_WORDS.cancel}
            confirmLabel={APPLICATION_WORDS.continue}
            size="sm"
            onResolve={(confirmed) =>
            {
              if (confirmed) void exportFrom(step.browser)
              else setStep({ kind: 'idle' })
            }}
          />
        )}
        <p role="status" className="text-label text-ink-2 empty:hidden">{status ?? ''}</p>
      </Row>
      <Row id={`${base}-saved`} label={APPLICATION_WORDS.savedLabel} hint={cookiesLine(info, browsers)}>
        <div>
          <Button size="sm" disabled={!info?.exists} onClick={() => void clear()}>{APPLICATION_WORDS.clear}</Button>
        </div>
      </Row>
    </Section>
  )
}

function AboutSection(): ReactElement
{
  const base = useId()
  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.about} lead={APPLICATION_WORDS.aboutLead}>
      <Row id={`${base}-project`} label={APPLICATION_WORDS.projectLabel} hint={APPLICATION_WORDS.projectHint}>
        <div>
          <Button size="sm" icon="action.external" onClick={() => void window.api.openExternal(PROJECT_URL)}>{APPLICATION_WORDS.openGitHub}</Button>
        </div>
      </Row>
    </Section>
  )
}

function DefaultsSection({ onResetDefaults }: { onResetDefaults: () => void }): ReactElement
{
  const base = useId()
  const [confirming, setConfirming] = useState(false)
  return (
    <Section id={`${base}-title`} title={APPLICATION_WORDS.defaults}>
      <Row id={`${base}-reset`} label={APPLICATION_WORDS.resetLabel} hint={APPLICATION_WORDS.resetHint}>
        <div>
          {confirming
            ? (
              <InlineConfirm
                question={APPLICATION_WORDS.resetQuestion}
                safeLabel={APPLICATION_WORDS.keep}
                confirmLabel={APPLICATION_WORDS.resetConfirm}
                size="sm"
                onResolve={(confirmed) =>
                {
                  setConfirming(false)
                  if (confirmed) onResetDefaults()
                }}
              />
            )
            : <Button size="sm" onClick={() => setConfirming(true)}>{APPLICATION_WORDS.reset}</Button>}
        </div>
      </Row>
    </Section>
  )
}

/** Settings, Application: updates and yt-dlp, the window, accessibility, YouTube cookies, the project page, and the reset. */
export function ApplicationSettings({ config, onUpdate, onResetDefaults }: ApplicationSettingsProps): ReactElement
{
  return (
    <div className="flex flex-col gap-6">
      <UpdatesSection config={config} onUpdate={onUpdate} />
      <YtDlpSettings
        autoUpdate={config.ytdlpAutoUpdate ?? true}
        onAutoUpdateChange={(next) => onUpdate('ytdlpAutoUpdate', next)}
        useSystem={config.ytdlpUseSystem ?? false}
        onUseSystemChange={(next) => onUpdate('ytdlpUseSystem', next)}
      />
      <WindowSection config={config} onUpdate={onUpdate} />
      <AccessibilityGroup interfaceScale={config.interfaceScale ?? 100} announceProgress={config.announceProgress ?? false} onUpdate={onUpdate} />
      <CookiesSection config={config} onUpdate={onUpdate} />
      <AboutSection />
      <DefaultsSection onResetDefaults={onResetDefaults} />
    </div>
  )
}
