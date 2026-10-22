/**
 * The editor shell: the empty editor with recent files, the mode switch and its keys, the file menu, and each
 * mode rendering against a loaded project.
 */
import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaEditor from '../../../src/renderer/src/components/editor/MediaEditor'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import { addRecentFile } from '../../../src/renderer/src/utils/recentFiles'
import { loadProject, resetEditor, stubApi } from './harness'

let api: ReturnType<typeof stubApi>

beforeEach(() =>
{
  api = stubApi()
  resetEditor()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('the empty editor', () =>
{
  it('opens straight into an empty Trim with plain words and Open file', () =>
  {
    render(<MediaEditor />)
    expect(screen.getByRole('heading', { name: 'Open a file to trim' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open file' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Editor modes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Trim' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('grid', { name: 'Recent files' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No recent files' })).toBeInTheDocument()
    expect(screen.getByText('Drop a file anywhere on this page, or choose Open file')).toBeInTheDocument()
  })

  it('names what each mode does as the switch changes', () =>
  {
    render(<MediaEditor />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
    expect(useEditorStore.getState().mode).toBe('edit')
    expect(screen.getByRole('heading', { name: 'Open files to edit on the timeline' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open files' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Inspect' }))
    expect(screen.getByRole('heading', { name: 'Open a file to inspect' })).toBeInTheDocument()
  })

  it('switches modes with Ctrl+1 to Ctrl+3 and opens the dialog with Ctrl+O', async () =>
  {
    render(<MediaEditor />)
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    expect(useEditorStore.getState().mode).toBe('edit')
    fireEvent.keyDown(window, { key: '3', ctrlKey: true })
    expect(useEditorStore.getState().mode).toBe('inspect')
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    expect(useEditorStore.getState().mode).toBe('clip')
    await act(async () =>
    {
      fireEvent.keyDown(window, { key: 'o', ctrlKey: true })
    })
    expect(api.openFiles).toHaveBeenCalledTimes(1)
  })

  it('lists recent files with name, length, and when they were opened, and opens one on Enter', async () =>
  {
    addRecentFile({ filePath: 'C:\\media\\clip-a.mp4', fileName: 'clip-a.mp4', openedAt: Date.now(), durationSec: 30 })
    render(<MediaEditor />)
    const grid = screen.getByRole('grid', { name: 'Recent files' })
    expect(within(grid).getByText('clip-a.mp4')).toBeInTheDocument()
    expect(within(grid).getByText('0:30')).toBeInTheDocument()
    expect(within(grid).getByText(/^Today, \d\d:\d\d$/)).toBeInTheDocument()
    const row = within(grid).getAllByRole('row').find((r) => r.textContent?.includes('clip-a.mp4'))!
    await act(async () =>
    {
      fireEvent.focus(row)
      fireEvent.keyDown(row, { key: 'Enter' })
    })
    expect(api.probeDetailed).toHaveBeenCalledWith('C:\\media\\clip-a.mp4')
  })

  it('clears the recent files only after the inline confirmation', () =>
  {
    addRecentFile({ filePath: 'C:\\media\\clip-a.mp4', fileName: 'clip-a.mp4', openedAt: Date.now(), durationSec: 30 })
    render(<MediaEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear list' }))
    expect(screen.getByRole('group', { name: 'Clear the recent files list?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.getByRole('grid', { name: 'Recent files' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear list' }))
    const confirm = screen.getByRole('group', { name: 'Clear the recent files list?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear list' }))
    expect(screen.queryByRole('grid', { name: 'Recent files' })).not.toBeInTheDocument()
  })

  it('opens the keyboard shortcuts with ? and closes them with ? again', () =>
  {
    render(<MediaEditor />)
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('shows what a drop will do while files are dragged over it', () =>
  {
    const { container } = render(<MediaEditor />)
    const root = container.querySelector('[class*="bg-ground"]') as HTMLElement
    fireEvent.dragEnter(root, { dataTransfer: { types: ['Files'], files: [] } })
    expect(container.querySelector('[data-drop-overlay]')?.textContent).toBe('Drop to open it in Trim')
    fireEvent.drop(root, { dataTransfer: { types: ['Files'], files: [] } })
    expect(container.querySelector('[data-drop-overlay]')).toBeNull()
  })
})

describe('a loaded project', () =>
{
  it('shows the last mode with the file menu for the active file', () =>
  {
    loadProject('clip')
    render(<MediaEditor />)
    expect(screen.getByRole('button', { name: 'clip-a.mp4, file menu' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'In point' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Out point' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Export' })).toBeInTheDocument()
  })

  it('renders the timeline with its tracks, clips, toolbar, and panels', () =>
  {
    loadProject('edit')
    const { container } = render(<MediaEditor />)
    expect(container.querySelectorAll('[data-clip]')).toHaveLength(3)
    expect(screen.getByRole('toolbar', { name: 'Timeline tools' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Playhead' })).toBeInTheDocument()
    expect(screen.getByRole('listbox', { name: 'Sources' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No clip selected' })).toBeInTheDocument()
  })

  it('renders Inspect for the active file', async () =>
  {
    loadProject('inspect')
    await act(async () =>
    {
      render(<MediaEditor />)
    })
    expect(api.probeReport).toHaveBeenCalledWith('C:\\media\\clip-a.mp4')
    expect(screen.getByRole('region', { name: 'Video, stream 0' })).toBeInTheDocument()
  })

  it('closes the file from its menu and returns Trim to the empty editor', () =>
  {
    loadProject('clip')
    render(<MediaEditor />)
    act(() =>
    {
      useEditorStore.getState().closeMediaFile()
    })
    expect(screen.getByRole('heading', { name: 'Open a file to trim' })).toBeInTheDocument()
  })
})
