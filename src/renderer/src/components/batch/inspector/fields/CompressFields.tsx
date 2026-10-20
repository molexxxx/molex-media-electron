/**
 * The Compress fields of the Recipe tab: mode, quality or target size, encoder, speed, and frame size up front; the
 * pixel format, tune, and audio fields most recipes leave alone sit behind "More settings".
 */
import type { ReactElement } from 'react'
import type { FieldKey } from '../../../../stores/recipeFields'
import { FieldStack, type VideoFieldsProps } from './ConvertFields'

/** Compress fields most recipes leave alone, shown behind "More settings". */
export const COMPRESS_MORE: ReadonlySet<FieldKey> = new Set<FieldKey>(['pixelFormat', 'tune', 'audio', 'audioBitrate'])

/**
 * The Compress fields of the Recipe tab. For one job the target size states this file's video and audio bitrates
 * from the shared size budget, the same numbers the encode runs with; for several it says each file's bitrate
 * follows its duration. The encoder field states which container the output keeps.
 */
export function CompressFields({ fields, onPatch }: VideoFieldsProps): ReactElement
{
  return <FieldStack fields={fields} onPatch={onPatch} scope="compress" more={COMPRESS_MORE} />
}
