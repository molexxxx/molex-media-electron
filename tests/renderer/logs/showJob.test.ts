/**
 * Show job from a log line: a job still in the lists is selected in the list that holds it, else in Queue; a job
 * that left the lists opens its batch in History, or a History search for its number.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobView } from '../../../src/shared/jobs/types'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { activeViewKey, useBatchView } from '../../../src/renderer/src/stores/batchView'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import { showJobInBatch } from '../../../src/renderer/src/components/logs/showJob'

function job(id: string, state: JobView['state'], runId: string | null = null): JobView
{
  return { id, state, runId } as unknown as JobView
}

function load(jobs: JobView[]): void
{
  useJobsStore.setState({
    ...initialJobsState(),
    status: 'hydrated',
    order: jobs.map((entry) => entry.id),
    jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry]))
  } as never, true)
}

beforeEach(() =>
{
  useAppStore.setState({ currentView: 'logs' })
  load([job('MM-0001', 'pending'), job('MM-0002', 'done', 'R-0003')])
})

afterEach(() =>
{
  useAppStore.setState(useAppStore.getInitialState(), true)
  useJobsStore.setState(initialJobsState(), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
})

describe('showJobInBatch', () =>
{
  it('selects a job in Queue and opens Batch', () =>
  {
    expect(showJobInBatch('MM-0002', 'R-0003')).toBe('list')
    const view = useBatchView.getState()
    expect(view.mode).toBe('queue')
    expect([...view.views.queue.selection.selected]).toEqual(['MM-0002'])
    expect(view.views.queue.selection.focus).toBe('MM-0002')
    expect(useAppStore.getState().currentView).toBe('batch')
  })

  it('keeps the current list when it holds the job', () =>
  {
    useBatchView.getState().setMode('review')
    showJobInBatch('MM-0001')
    expect(useBatchView.getState().mode).toBe('review')
    expect([...useBatchView.getState().views.review.selection.selected]).toEqual(['MM-0001'])
  })

  it('moves to Queue when the current list does not hold the job', () =>
  {
    useBatchView.getState().setMode('review')
    showJobInBatch('MM-0002')
    expect(useBatchView.getState().mode).toBe('queue')
  })

  it("opens a gone job's batch in History with the job selected", () =>
  {
    expect(showJobInBatch('MM-0042', 'R-0007')).toBe('history')
    const view = useBatchView.getState()
    expect(view.mode).toBe('history')
    expect(view.history.openRunId).toBe('R-0007')
    expect([...view.views.historyBatch.selection.selected]).toEqual(['MM-0042'])
    expect(useAppStore.getState().currentView).toBe('batch')
  })

  it('searches History for a gone job without a batch', () =>
  {
    showJobInBatch('MM-0042')
    const view = useBatchView.getState()
    expect(view.mode).toBe('history')
    expect(view.history.query).toBe('MM-0042')
    expect(activeViewKey(view)).toBe('historyResults')
  })
})
