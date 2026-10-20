/**
 * Summary-slot banners: every run alert kind's words, counts, and controls with the jobs they act on; holding
 * until dismissed or resolved; the alert role only for run-blocking errors raised after load; the restored batch's
 * acknowledgment; and the run notices composed around them.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import
{
  BLOCKING_ALERT_KINDS,
  NoticeBanner,
  RESTORED_ACKNOWLEDGMENT_ID,
  RunBanner,
  RunBanners,
  alertWords,
  bannerText,
  orderAlerts,
  reloadWords,
  restoredAcknowledgmentText,
  scanStoppedWords,
  type AlertContext,
  type RestoredAcknowledgment
} from '../../../src/renderer/src/components/batch/summary/Banners'
import { AppendedJobsLine, RunNotices, appendedLine } from '../../../src/renderer/src/components/batch/summary/RunNotices'
import { formatCatalog, formatRunId, type JobId } from '../../../src/shared/jobs/ids'
import type { JobState, RunAlert, RunAlertKind, ScanState } from '../../../src/shared/jobs/types'

const RUN = formatRunId(31)
const ids = (...seqs: number[]): JobId[] => seqs.map((seq) => formatCatalog(seq))

function alert(kind: RunAlertKind, patch: Partial<RunAlert> = {}): RunAlert
{
  return {
    id: `${kind}-1`,
    kind,
    severity: 'warning',
    message: '',
    at: 2000,
    volume: null,
    path: null,
    jobIds: [],
    counts: null,
    dismissible: false,
    ...patch
  }
}

const CONTEXT: AlertContext = { runId: RUN }

afterEach(() =>
{
  cleanup()
})

describe('alertWords', () =>
{
  it('words a full disk from main\'s numbers with Resume, Write the rest elsewhere, and Select waiting', () =>
  {
    const words = alertWords(alert('disk-space', {
      volume: 'D:',
      message: 'D: has 1.2 GB free; the next job needs about 4.1 GB. Free some space, then resume.',
      jobIds: ids(140, 141)
    }), CONTEXT)
    expect(words.body).toBe('D: has 1.2 GB free; the next job needs about 4.1 GB. Free some space, then resume.')
    expect(words.actions.map((a) => a.label)).toEqual(['Resume', 'Write the rest elsewhere…', 'Select waiting'])
    expect(words.actions[1].jobIds).toEqual(ids(140, 141))
    expect(words.actions[2].jobIds).toEqual(ids(140, 141))
    expect(words.blocking).toBe(true)
    expect(words.dismissible).toBe(false)
  })

  it('falls back to the volume when main sends no sentence for a full disk', () =>
  {
    expect(alertWords(alert('disk-space', { volume: 'E:' }), CONTEXT).body).toBe('E: is full. Free some space, then resume.')
    expect(alertWords(alert('disk-space'), { runId: null }).body).toBe('The destination drive is full. Free some space, then resume.')
    expect(alertWords(alert('disk-space'), { runId: null }).actions.map((a) => a.id)).toEqual(['write-elsewhere', 'select-waiting'])
  })

  it('says when Output unlocks after Write the rest elsewhere, then offers Change output', () =>
  {
    const disk = alert('disk-space', { volume: 'D:', message: 'D: has 1.2 GB free; the next job needs about 4.1 GB. Free some space, then resume.' })
    const waiting = alertWords(disk, { runId: RUN, writeElsewhere: 'waiting', running: 3 })
    expect(waiting.body).toContain('Output unlocks when 3 running jobs finish.')
    expect(waiting.actions).toEqual([])
    const one = alertWords(disk, { runId: RUN, writeElsewhere: 'waiting', running: 1 })
    expect(one.body).toContain('Output unlocks when 1 running job finishes.')
    expect(alertWords(disk, { runId: RUN, writeElsewhere: 'waiting' }).body).toContain('0 running jobs')
    const unlocked = alertWords(disk, { runId: RUN, writeElsewhere: 'unlocked' })
    expect(unlocked.actions.map((a) => a.label)).toEqual(['Change output'])
  })

  it('words a full disk holding molexMedia\'s own data as a queue that cannot be saved', () =>
  {
    const words = alertWords(alert('disk-space', { volume: 'C:' }), { runId: RUN, dataVolume: 'C:' })
    expect(words.body).toBe('molexMedia cannot save its queue: C: is full. Batch 31 is paused; free some space, then resume.')
    expect(words.actions.map((a) => a.label)).toEqual(['Resume'])
    expect(alertWords(alert('disk-space', { volume: 'C:' }), { runId: null, dataVolume: 'C:' }).body)
      .toBe('molexMedia cannot save its queue: C: is full. Free some space.')
  })

  it('words an unavailable destination with the batch it paused', () =>
  {
    const words = alertWords(alert('destination-unavailable', { path: 'D:\\Exports', jobIds: ids(150) }), CONTEXT)
    expect(words.body).toBe('D:\\Exports is not available. Batch 31 is paused; reconnect it, then resume.')
    expect(words.actions.map((a) => a.label)).toEqual(['Resume', 'Write the rest elsewhere…'])
    expect(words.actions[1].jobIds).toEqual(ids(150))
    expect(alertWords(alert('destination-unavailable', { volume: 'F:' }), { runId: null }).body)
      .toBe('F: is not available. Reconnect it, then try again.')
    expect(alertWords(alert('destination-unavailable'), CONTEXT).body.startsWith('The destination is not available.')).toBe(true)
    expect(alertWords(alert('destination-unavailable', { path: 'D:\\Exports' }), { runId: RUN, writeElsewhere: 'waiting', running: 2 }).body)
      .toContain('Output unlocks when 2 running jobs finish.')
  })

  it('quotes the cause when saving the queue fails, with Resume and Show log', () =>
  {
    const words = alertWords(alert('storage-error', { severity: 'error', message: 'access denied.' }), CONTEXT)
    expect(words.body).toBe('molexMedia cannot save its queue: access denied. Batch 31 is paused until saving works again.')
    expect(words.actions.map((a) => a.label)).toEqual(['Resume', 'Show log'])
    const full = alertWords(alert('storage-error', { message: 'molexMedia cannot save its queue: the file is locked.' }), { runId: null })
    expect(full.body).toBe('molexMedia cannot save its queue: the file is locked.')
    expect(full.actions.map((a) => a.id)).toEqual(['show-log'])
  })

  it('words FFmpeg not ready with Open Settings, quoting the reason once', () =>
  {
    const words = alertWords(alert('ffmpeg-unavailable', { severity: 'error', message: 'the self-test failed' }), CONTEXT)
    expect(words.body).toBe('FFmpeg is not ready: the self-test failed. Jobs cannot start.')
    expect(words.actions.map((a) => a.label)).toEqual(['Open Settings'])
    expect(words.blocking).toBe(true)
    expect(alertWords(alert('ffmpeg-unavailable', { message: 'FFmpeg is not ready: missing. Jobs cannot start.' }), CONTEXT).body)
      .toBe('FFmpeg is not ready: missing. Jobs cannot start.')
  })

  it('words a lowered GPU limit as a dismissible notice', () =>
  {
    const words = alertWords(alert('gpu-sessions', {
      severity: 'info',
      message: 'NVENC refused a session; GPU encodes at once lowered to 3 for this session.'
    }), CONTEXT)
    expect(words.body).toBe('NVENC refused a session; GPU encodes at once lowered to 3 for this session.')
    expect(words.tone).toBe('info')
    expect(words.dismissible).toBe(true)
    expect(words.blocking).toBe(false)
  })

  it('words a pending cleanup with Show folder only when there is a path', () =>
  {
    const words = alertWords(alert('cleanup-pending', { path: 'D:\\Exports\\.molexmedia-work' }), CONTEXT)
    expect(words.body).toBe('molexMedia could not delete a temporary folder yet: D:\\Exports\\.molexmedia-work. It tries again every minute.')
    expect(words.actions).toEqual([{ id: 'show-folder', label: 'Show folder', jobIds: [], path: 'D:\\Exports\\.molexmedia-work' }])
    const bare = alertWords(alert('cleanup-pending', { message: 'C:\\Temp\\mm-1.' }), CONTEXT)
    expect(bare.body).toContain('yet: C:\\Temp\\mm-1. It tries')
    expect(bare.actions).toEqual([])
  })

  it('words an interrupted batch with only the parts present and acts on the right jobs', () =>
  {
    const states: Record<string, JobState> = { [formatCatalog(1)]: 'interrupted', [formatCatalog(2)]: 'interrupted', [formatCatalog(3)]: 'interrupted', [formatCatalog(4)]: 'held', [formatCatalog(5)]: 'queued' }
    const restored = alert('restored-run', {
      jobIds: ids(1, 2, 3, 4, 5),
      counts: { interrupted: 3, decisions: 1, queued: 12, restored: 0, missing: 0 }
    })
    const words = alertWords(restored, { runId: RUN, stateOf: (id) => states[id] })
    expect(bannerText(words)).toBe(
      'molexMedia closed during Batch 31. 3 jobs were interrupted; their partial files were removed. ' +
      '1 job was saving its output and needs a decision. 12 queued jobs are paused.'
    )
    expect(words.actions.map((a) => a.label)).toEqual(['Retry 3 interrupted', 'Show'])
    expect(words.actions[0].jobIds).toEqual(ids(1, 2, 3))
    expect(words.actions[1].jobIds).toEqual(ids(4))
  })

  it('words the other counts of an interrupted batch', () =>
  {
    const one = alertWords(alert('restored-run', { counts: { interrupted: 1, decisions: 2, queued: 1, restored: 0, missing: 0 }, jobIds: ids(9) }), { runId: null })
    expect(bannerText(one)).toBe(
      'molexMedia closed during the last batch. 1 job was interrupted; its partial file was removed. ' +
      '2 jobs were saving their outputs and need a decision. 1 queued job is paused.'
    )
    expect(one.actions[0].jobIds).toEqual(ids(9))
    const none = alertWords(alert('restored-run'), CONTEXT)
    expect(none.body).toBe('')
    expect(none.actions).toEqual([])
  })

  it('words a restored queue with Show missing only when sources are missing', () =>
  {
    const words = alertWords(alert('restored-queue', {
      severity: 'info',
      jobIds: ids(10, 11, 12),
      counts: { interrupted: 0, decisions: 0, queued: 0, restored: 18, missing: 2 }
    }), { runId: null, isMissing: (id) => id === formatCatalog(11) })
    expect(words.body).toBe('Restored 18 jobs from your last session. 2 sources are missing.')
    expect(words.actions.map((a) => a.label)).toEqual(['Show missing', 'Clear restored jobs'])
    expect(words.actions[0].jobIds).toEqual(ids(11))
    expect(words.actions[1].jobIds).toEqual(ids(10, 11, 12))
    const clean = alertWords(alert('restored-queue', { counts: { interrupted: 0, decisions: 0, queued: 0, restored: 1, missing: 0 } }), { runId: null })
    expect(clean.body).toBe('Restored 1 job from your last session.')
    expect(clean.actions.map((a) => a.id)).toEqual(['clear-restored'])
    const unknown = alertWords(alert('restored-queue', { jobIds: ids(7), counts: { interrupted: 0, decisions: 0, queued: 0, restored: 1, missing: 1 } }), { runId: null })
    expect(unknown.body).toContain('1 source is missing.')
    expect(unknown.actions[0].jobIds).toEqual(ids(7))
  })

  it('words an offline volume for reading jobs and for outputs waiting for a decision', () =>
  {
    expect(alertWords(alert('volume-offline', { volume: 'D:' }), CONTEXT).body)
      .toBe('D: is not reachable. Jobs reading from it wait and start when it returns.')
    expect(alertWords(alert('volume-offline', { volume: 'D:', counts: { interrupted: 0, decisions: 2, queued: 0, restored: 0, missing: 0 } }), CONTEXT).body)
      .toBe('D: is not reachable. 2 jobs waiting for a decision keep their outputs there; decide when it returns.')
    expect(alertWords(alert('volume-offline', { counts: { interrupted: 0, decisions: 1, queued: 0, restored: 0, missing: 0 } }), CONTEXT).body)
      .toBe('A drive is not reachable. 1 job waiting for a decision keeps its output there; decide when it returns.')
    expect(alertWords(alert('volume-offline'), CONTEXT).dismissible).toBe(true)
  })

  it('words an unreadable queue file and a migrated Replace setting', () =>
  {
    const recovered = alertWords(alert('queue-recovered', { path: 'C:\\data\\queue.bad.json' }), CONTEXT)
    expect(recovered.body).toBe('The saved queue could not be read and was set aside. The queue starts empty.')
    expect(recovered.actions).toEqual([{ id: 'show-file', label: 'Show file', jobIds: [], path: 'C:\\data\\queue.bad.json' }])
    expect(alertWords(alert('queue-recovered'), CONTEXT).actions).toEqual([])
    const migrated = alertWords(alert('replace-migrated', { severity: 'info' }), CONTEXT)
    expect(migrated.body).toBe('Replace originals is now chosen per batch. This batch writes next to each source.')
    expect(migrated.actions.map((a) => a.label)).toEqual(['Change output'])
    expect(migrated.dismissible).toBe(true)
  })

  it('honors main\'s dismissible flag and maps severity to tone', () =>
  {
    expect(alertWords(alert('cleanup-pending', { dismissible: true }), CONTEXT).dismissible).toBe(true)
    expect(alertWords(alert('storage-error', { severity: 'error' }), CONTEXT).tone).toBe('error')
    expect(alertWords(alert('cleanup-pending'), CONTEXT).tone).toBe('warning')
  })
})

describe('notice words', () =>
{
  it('words the one notice after a reload', () =>
  {
    const words = reloadWords(3, RUN)
    expect(words.body).toBe('The window reloaded. 3 jobs need attention in Batch 31. Undo history was cleared.')
    expect(words.actions.map((a) => a.label)).toEqual(['Show'])
    expect(words.dismissible).toBe(true)
    expect(reloadWords(1, RUN).body).toContain('1 job needs attention')
  })

  it('words a stopped folder scan', () =>
  {
    expect(scanStoppedWords({ root: 'E:\\Rips', added: 120 }).body)
      .toBe('Folder scan stopped: E:\\Rips is no longer available. Added 120 files found before the error.')
  })

  it('words the restored acknowledgment for originals, existing files, and both', () =>
  {
    expect(restoredAcknowledgmentText({ originals: 12, overwrites: 0, drive: 'D:', platform: 'win32' }))
      .toBe('I understand that 12 originals go to the Recycle Bin on D: after their outputs verify.')
    expect(restoredAcknowledgmentText({ originals: 1, overwrites: 2, drive: null, platform: 'win32' }))
      .toBe('I understand that 1 original goes to the Recycle Bin after its output verifies and 2 existing files go to the Recycle Bin and are replaced.')
    expect(restoredAcknowledgmentText({ originals: 0, overwrites: 1, drive: 'D:', platform: 'darwin' }))
      .toBe('I understand that 1 existing file goes to the Trash and is replaced.')
  })

  it('orders run-blocking alerts first and keeps main\'s order otherwise', () =>
  {
    const list = [alert('gpu-sessions', { id: 'a' }), alert('disk-space', { id: 'b' }), alert('cleanup-pending', { id: 'c' }), alert('ffmpeg-unavailable', { id: 'd' })]
    expect(orderAlerts(list).map((a) => a.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(BLOCKING_ALERT_KINDS).toEqual(['disk-space', 'destination-unavailable', 'ffmpeg-unavailable', 'storage-error'])
  })
})

describe('RunBanner', () =>
{
  it('reads a run-blocking alert raised after load as an alert', () =>
  {
    render(<RunBanner alert={alert('disk-space', { volume: 'D:', at: 5000 })} context={CONTEXT} loadedAt={1000} onAction={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('D: is full.')
  })

  it('reads a blocking alert present at load, and a non-blocking error, as a status', () =>
  {
    const { container } = render(
      <>
        <RunBanner alert={alert('ffmpeg-unavailable', { severity: 'error', message: 'missing', at: 500 })} context={CONTEXT} loadedAt={1000} onAction={() => {}} />
        <RunBanner alert={alert('cleanup-pending', { severity: 'error', at: 5000, path: 'C:\\t' })} context={CONTEXT} loadedAt={1000} onAction={() => {}} />
      </>
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(2)
    expect(container.querySelector('[data-alert-kind="ffmpeg-unavailable"] [data-blocking]')).not.toBeNull()
  })

  it('holds a blocking banner with no Dismiss until its owner removes it', () =>
  {
    const view = render(<RunBanner alert={alert('disk-space', { volume: 'D:' })} context={CONTEXT} loadedAt={0} onAction={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(view.container.querySelector('[data-held]')).not.toBeNull()
    view.rerender(<RunBanners alerts={[]} context={CONTEXT} onAction={() => {}} />)
    expect(screen.queryByText(/is full/u)).toBeNull()
  })

  it('dismisses a dismissible banner and tells its owner', () =>
  {
    const onDismiss = vi.fn()
    const gpu = alert('gpu-sessions', { severity: 'info', message: 'NVENC refused a session; GPU encodes at once lowered to 3 for this session.' })
    render(<RunBanner alert={gpu} context={CONTEXT} loadedAt={0} onAction={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith(gpu)
    expect(screen.queryByText(/NVENC/u)).toBeNull()
  })

  it('passes each control with its jobs and its alert', () =>
  {
    const onAction = vi.fn()
    const disk = alert('disk-space', { volume: 'D:', jobIds: ids(140) })
    render(<RunBanner alert={disk} context={CONTEXT} loadedAt={0} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select waiting' }))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'select-waiting', jobIds: ids(140) }), disk)
  })

  it('carries the restored batch\'s acknowledgment under Replace', () =>
  {
    const onChange = vi.fn()
    const ack: RestoredAcknowledgment = { originals: 12, overwrites: 0, drive: 'D:', platform: 'win32', checked: false, onChange }
    const restored = alert('restored-run', { counts: { interrupted: 3, decisions: 0, queued: 12, restored: 0, missing: 0 } })
    const { container } = render(<RunBanner alert={restored} context={CONTEXT} loadedAt={0} onAction={() => {}} acknowledgment={ack} />)
    const box = screen.getByRole('checkbox', { name: 'I understand that 12 originals go to the Recycle Bin on D: after their outputs verify.' })
    expect(box.id).toBe(RESTORED_ACKNOWLEDGMENT_ID)
    expect(container.querySelector(`#${RESTORED_ACKNOWLEDGMENT_ID}`)).toBe(box)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('leaves the acknowledgment out when nothing is replaced or the alert is another kind', () =>
  {
    const ack: RestoredAcknowledgment = { originals: 0, overwrites: 0, drive: null, platform: 'win32', checked: false, onChange: () => {} }
    render(
      <>
        <RunBanner alert={alert('restored-run', { counts: { interrupted: 1, decisions: 0, queued: 0, restored: 0, missing: 0 } })} context={CONTEXT} loadedAt={0} onAction={() => {}} acknowledgment={ack} />
        <RunBanner alert={alert('cleanup-pending', { id: 'x' })} context={CONTEXT} loadedAt={0} onAction={() => {}} acknowledgment={{ ...ack, originals: 3 }} />
      </>
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('RunBanners', () =>
{
  it('renders nothing without alerts', () =>
  {
    const { container } = render(<RunBanners alerts={[]} context={CONTEXT} onAction={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders every alert, blocking first, reading alerts raised after mount as alerts', () =>
  {
    const later = Date.now() + 60_000
    const { container } = render(
      <RunBanners
        alerts={[alert('gpu-sessions', { id: 'g', message: 'NVENC refused a session.' }), alert('destination-unavailable', { id: 'd', path: 'D:\\Exports', at: later })]}
        context={CONTEXT}
        onAction={() => {}}
      />
    )
    const kinds = Array.from(container.querySelectorAll('[data-alert-kind]')).map((node) => node.getAttribute('data-alert-kind'))
    expect(kinds).toEqual(['destination-unavailable', 'gpu-sessions'])
    expect(within(screen.getByRole('alert')).getByText(/D:\\Exports is not available/u)).toBeInTheDocument()
  })

  it('uses the snapshot time it is given', () =>
  {
    render(<RunBanners alerts={[alert('storage-error', { severity: 'error', at: 10 })]} loadedAt={100} context={CONTEXT} onAction={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('NoticeBanner', () =>
{
  it('draws a notice with its controls and dismissal', () =>
  {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    render(<NoticeBanner words={reloadWords(2, RUN)} onAction={onAction} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'show-attention' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('draws a notice without controls', () =>
  {
    render(<NoticeBanner words={{ ...scanStoppedWords({ root: 'E:\\', added: 0 }), dismissible: false }} onAction={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Added 0 files')
  })
})

function scan(status: ScanState['status'], patch: Partial<ScanState> = {}): ScanState
{
  return {
    scanId: `scan-${status}`,
    root: 'E:\Rips',
    status,
    error: status === 'failed' ? 'ENOENT' : null,
    visited: 200,
    added: 120,
    excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 },
    ...patch
  }
}

describe('RunNotices', () =>
{
  it('words jobs appended outside the running batch', () =>
  {
    expect(appendedLine(3, RUN)).toBe('3 new jobs are not in Batch 31.')
    expect(appendedLine(1, RUN)).toBe('1 new job is not in Batch 31.')
  })

  it('offers the brass Review on the appended jobs', () =>
  {
    const onReview = vi.fn()
    render(<AppendedJobsLine count={3} runId={RUN} onReview={onReview} />)
    const button = screen.getByRole('button', { name: 'Review 3 new jobs' })
    expect(button.className).toContain('bg-brass')
    fireEvent.click(button)
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('draws the appended control neutral when the brass is elsewhere', () =>
  {
    render(<RunNotices runId={RUN} appended={2} appendedBrass={false} onAction={() => {}} />)
    expect(screen.getByRole('button', { name: 'Review 2 new jobs' }).className).not.toContain('bg-brass')
    fireEvent.click(screen.getByRole('button', { name: 'Review 2 new jobs' }))
  })

  it('collapses to nothing when it has nothing to say', () =>
  {
    const { container } = render(
      <RunNotices runId={RUN} appended={0} reloadAttention={0} scans={[scan('scanning'), scan('done')]} onAction={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
    const none = render(<RunNotices runId={null} appended={4} reloadAttention={3} onAction={() => {}} />)
    expect(none.container).toBeEmptyDOMElement()
  })

  it('composes the appended line, the run banners, the reload notice, and stopped scans', () =>
  {
    const onAction = vi.fn()
    const onReviewAppended = vi.fn()
    const onDismissReload = vi.fn()
    const onDismissScan = vi.fn()
    const disk = alert('disk-space', { volume: 'D:', jobIds: ids(140) })
    const failed = scan('failed')
    render(
      <RunNotices
        runId={RUN}
        appended={3}
        onReviewAppended={onReviewAppended}
        alerts={[disk]}
        context={{ running: 2 }}
        loadedAt={0}
        onAction={onAction}
        reloadAttention={3}
        onDismissReload={onDismissReload}
        scans={[failed]}
        onDismissScan={onDismissScan}
      />
    )
    expect(screen.getByText('3 new jobs are not in Batch 31.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('D: is full.')
    expect(screen.getByText('The window reloaded. 3 jobs need attention in Batch 31. Undo history was cleared.')).toBeInTheDocument()
    expect(screen.getByText('Folder scan stopped: E:\Rips is no longer available. Added 120 files found before the error.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review 3 new jobs' }))
    expect(onReviewAppended).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'resume' }), disk)
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'show-attention' }), null)
    const dismissals = screen.getAllByRole('button', { name: 'Dismiss' })
    expect(dismissals).toHaveLength(2)
    dismissals.forEach((button) => fireEvent.click(button))
    expect(onDismissReload).toHaveBeenCalled()
    expect(onDismissScan).toHaveBeenCalledWith(failed)
    expect(screen.queryByText(/The window reloaded/u)).toBeNull()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('passes the restored acknowledgment to the restored-run banner and dismisses alerts through its owner', () =>
  {
    const onDismissAlert = vi.fn()
    const ack: RestoredAcknowledgment = { originals: 2, overwrites: 0, drive: 'D:', platform: 'win32', checked: true, onChange: () => {} }
    const gpu = alert('gpu-sessions', { id: 'gpu', message: 'NVENC refused a session.' })
    render(
      <RunNotices
        runId={RUN}
        alerts={[alert('restored-run', { counts: { interrupted: 1, decisions: 0, queued: 3, restored: 0, missing: 0 } }), gpu]}
        acknowledgment={ack}
        onAction={() => {}}
        onDismissAlert={onDismissAlert}
        scans={[scan('failed')]}
      />
    )
    expect(screen.getByRole('checkbox')).toBeChecked()
    const dismissals = screen.getAllByRole('button', { name: 'Dismiss' })
    fireEvent.click(dismissals[0])
    expect(onDismissAlert).toHaveBeenCalledWith(gpu)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Folder scan stopped/u)).toBeNull()
  })
})
