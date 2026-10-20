/**
 * The Extract fields of the Recipe tab: what to extract, the fields of that mode, and the trim in the modes that
 * honor it; sample rate, channels, GIF dither and loop, and JPEG quality sit behind "More settings".
 */
import type { ReactElement } from 'react'
import type { FieldKey } from '../../../../stores/recipeFields'
import { FieldStack, type VideoFieldsProps } from './ConvertFields'

/** Extract fields most recipes leave alone, shown behind "More settings". */
export const EXTRACT_MORE: ReadonlySet<FieldKey> = new Set<FieldKey>(['sampleRate', 'channels', 'dither', 'loop', 'jpgQuality'])

/**
 * The Extract fields of the Recipe tab. One job picks among the file's real streams; several pick by rule (default
 * stream, first stream in a language, stream number). Start and Duration show only in the modes that honor a trim,
 * with the keyframe note when a copied clip can start early.
 */
export function ExtractFields({ fields, onPatch }: VideoFieldsProps): ReactElement
{
  return <FieldStack fields={fields} onPatch={onPatch} scope="extract" more={EXTRACT_MORE} />
}
