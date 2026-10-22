/**
 * @module editor/open
 * How files reach the editor: the open dialog, drops, and recent files load the first file as the active file
 * (which Trim and Inspect show and the timeline adds to its sources); the timeline adds the rest as sources.
 */
import { useEditorStore } from '../../stores/editorStore'
import { toast } from '../../ui/Toast'
import type { EditorMode, MediaSource } from './types'

function fileName(filePath: string): string
{
  return filePath.split(/[\\/]/).pop() || filePath
}

/**
 * Probes each path and adds it to the timeline's sources, skipping files already there. Returns how many were
 * added; files that cannot be probed are named in one error toast.
 */
export async function importSources(paths: readonly string[]): Promise<number>
{
  let added = 0
  const failed: string[] = []
  for (const filePath of paths)
  {
    const state = useEditorStore.getState()
    if (state.sources.some((source) => source.filePath === filePath))
    {
      continue
    }
    const probe = await window.api.probeDetailed(filePath)
    if (!probe?.success || !probe.data)
    {
      failed.push(fileName(filePath))
      continue
    }
    const info = probe.data
    const video = info.videoStreams?.[0]
    const audio = info.audioStreams?.[0]
    const durationSeconds = parseFloat(info.format?.duration || '0')
    const frameRate = useEditorStore.getState().project.frameRate
    const source: MediaSource = {
      id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      filePath,
      fileName: fileName(filePath),
      duration: Math.round(durationSeconds * frameRate),
      frameRate,
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      audioChannels: audio?.channels ?? 0,
      audioSampleRate: parseInt(audio?.sample_rate || '0', 10),
      codec: video?.codec_name || audio?.codec_name || 'unknown',
      format: info.format?.format_name || 'unknown',
      fileSize: parseInt(info.format?.size || '0', 10),
      durationSeconds
    }
    useEditorStore.getState().addSource(source)
    added += 1
  }
  if (failed.length > 0)
  {
    toast.show({
      tone: 'error',
      title: failed.length === 1 ? `Could not add ${failed[0]}` : `Could not add ${failed.length} files`,
      body: 'FFprobe could not read them. Check that each file exists and is a video, audio, or image file.'
    })
  }
  return added
}

/**
 * Opens files into the editor: the first becomes the active file and, in the timeline, the rest join its sources.
 * A file that cannot be read is named in an error toast with the way out.
 */
export async function openPaths(paths: readonly string[], mode: EditorMode): Promise<boolean>
{
  if (paths.length === 0)
  {
    return false
  }
  const result = await useEditorStore.getState().loadMediaFile(paths[0])
  if (!result.success)
  {
    toast.show({
      tone: 'error',
      title: `Could not open ${fileName(paths[0])}`,
      body: `${result.error ?? 'FFprobe could not read it.'} Check that the file exists and is a video, audio, or image file.`
    })
  }
  if (mode === 'edit' && paths.length > 1)
  {
    await importSources(paths.slice(1))
  }
  return result.success
}

/** Shows the open dialog and opens what the user picks. */
export async function openWithDialog(mode: EditorMode): Promise<boolean>
{
  const files: string[] | undefined = await window.api.openFiles()
  if (!files || files.length === 0)
  {
    return false
  }
  return openPaths(mode === 'edit' ? files : files.slice(0, 1), mode)
}

/** The paths of the files in a drop, leaving out anything that is not a file on disk. */
export function droppedPaths(transfer: DataTransfer): string[]
{
  return Array.from(transfer.files)
    .map((file) => window.api.getFilePath(file))
    .filter((filePath): filePath is string => Boolean(filePath))
}
