/**
 * Banner: the role follows the tone (an error that appears after load is an alert, every other banner a
 * status), the dismiss control is an IconButton named "Dismiss", and a held banner stays until dismissed.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Banner, type BannerTone } from '../../../src/renderer/src/ui/Banner'
import { Button } from '../../../src/renderer/src/ui/Button'

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Banner', () =>
{
  it.each<[BannerTone, 'status' | 'alert']>([
    ['info', 'status'],
    ['success', 'status'],
    ['warning', 'status'],
    ['error', 'alert']
  ])('gives a %s banner the %s role', (tone, role) =>
  {
    render(<Banner tone={tone}>FFmpeg is not ready: the binary is missing. Jobs cannot start.</Banner>)
    const banner = screen.getByRole(role)
    expect(banner).toHaveAttribute('data-tone', tone)
    expect(banner).toHaveTextContent('FFmpeg is not ready: the binary is missing. Jobs cannot start.')
    expect(banner.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps an error present before the document loaded a status, and honors an explicit role', () =>
  {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    const { unmount } = render(<Banner tone="error">The saved queue could not be read and was set aside.</Banner>)
    expect(screen.getByRole('status')).toHaveTextContent('The saved queue could not be read')
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()
    vi.restoreAllMocks()
    render(<Banner tone="error" role="status">D: is full.</Banner>)
    expect(screen.getByRole('status')).toHaveTextContent('D: is full.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads the title in ink and the children as secondary text, with actions below', () =>
  {
    const choose = vi.fn()
    render(
      <Banner tone="warning" title="Paused: D: is full." actions={<Button size="sm" onClick={choose}>Write the rest elsewhere</Button>}>
        D: has 1.2 GB free; the next job needs about 4.1 GB.
      </Banner>
    )
    expect(screen.getByText('Paused: D: is full.')).toHaveClass('text-ink')
    expect(screen.getByText('D: has 1.2 GB free; the next job needs about 4.1 GB.')).toHaveClass('text-ink-2')
    fireEvent.click(screen.getByRole('button', { name: 'Write the rest elsewhere' }))
    expect(choose).toHaveBeenCalledTimes(1)
    cleanup()
    render(<Banner tone="info">Restored 18 jobs from your last session.</Banner>)
    expect(screen.getByText('Restored 18 jobs from your last session.')).toHaveClass('text-ink')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('labels the dismiss control, hides the banner, and calls onDismiss', () =>
  {
    const onDismiss = vi.fn()
    render(<Banner tone="info" onDismiss={onDismiss}>NVENC refused a session; GPU encodes at once lowered to 3 for this session.</Banner>)
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toHaveAttribute('data-size', 'sm')
    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a held banner until it is dismissed', () =>
  {
    vi.useFakeTimers()
    const { rerender } = render(
      <Banner tone="warning" held title="Paused: D:\Exports is not available.">
        Jobs writing there wait until it returns.
      </Banner>
    )
    const banner = screen.getByRole('status')
    expect(banner).toHaveAttribute('data-held')
    act(() =>
    {
      vi.advanceTimersByTime(10 * 60_000)
    })
    rerender(
      <Banner tone="warning" held title="Paused: D:\Exports is not available.">
        Jobs writing there wait until it returns.
      </Banner>
    )
    expect(screen.getByRole('status')).toBe(banner)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
