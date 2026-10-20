/**
 * Stacking model for the color token contrast test. Every pair the test measures is generated from these
 * declarations instead of a hand-listed table, so a new ground, state wash, or token cannot skip a stack, and
 * a token that appears in no generated pair and no exemption fails the test.
 */

/** Minimum WCAG 2.x contrast ratio for a pair, or null for a pair that is measured but has no floor. */
export type Floor = number | null

/** A painted ground: an opaque base token, optionally with one state layer (a wash or an opaque state token) over it. */
export interface Surface
{
  name: string
  base: string
  layer?: string
}

/** One foreground token measured against one surface. */
export interface Pair
{
  fg: string
  bg: Surface
  floor: Floor
  role: string
}

/**
 * Which surfaces a rule applies to: `all` (every ground and state), `selected` (every selected composite),
 * `rows` (every ground and panel state, where rows and items live), or a list of surface names and opaque tokens.
 */
export type SurfaceSelector = 'all' | 'selected' | 'rows' | string[]

/** Tokens left out of the floors on purpose. With `surfaces`, only the pairs on those surfaces are exempt. */
export interface Exemption
{
  tokens: string[]
  surfaces?: SurfaceSelector
  reason: string
}

/** Every ground a row, item, or control can sit on, with the states each one allows. */
export const BASE_STATES: Array<{ base: string; states: Array<[state: string, layer: string | null]> }> = [
  {
    base: 'ground',
    states: [['rest', null], ['hover', 'wash-hover'], ['pressed', 'wash-pressed'], ['selected', 'wash-selected'], ['selected hover', 'wash-selected-hover']]
  },
  {
    base: 'panel',
    states: [['rest', null], ['hover', 'wash-hover'], ['selected', 'wash-selected'], ['selected hover', 'wash-selected-hover']]
  },
  {
    base: 'rail',
    states: [['rest', null], ['hover', 'wash-hover'], ['selected', 'wash-selected']]
  },
  {
    base: 'raised',
    states: [['rest', null], ['hover', 'raised-hover']]
  },
  {
    base: 'sunken',
    states: [['rest', null]]
  },
  {
    base: 'overlay',
    states: [['rest', null], ['hover', 'wash-hover']]
  }
]

/** Text and status inks with their floors; each one is measured on every ground and state. */
export const TEXT_INKS: Record<string, Floor> = {
  'ink': 10,
  'ink-2': 7,
  'ink-3': 4.5,
  'running': 4.5,
  'verified': 4.5,
  'warning': 4.5,
  'error': 4.5,
  'walnut-ink': 4.5,
  'brass': 3,
  'ink-disabled': null
}

/** The 11 px uppercase caption ink and its floor. */
export const CAPTION_INK = { token: 'ink-2', floor: 7 }

/** Opaque label grounds that sit inside rows, with the inks drawn on them. */
export const LABEL_GROUNDS: Array<{ ground: string; inks: Record<string, number>; role: string }> = [
  { ground: 'held-warning', inks: { 'warning': 4.5, 'ink': 10, 'ink-2': 7 }, role: 'held warning label' },
  { ground: 'held-error', inks: { 'error': 4.5, 'ink': 10, 'ink-2': 7 }, role: 'held error label' },
  { ground: 'stamp-verified', inks: { 'verified': 4.5, 'ink': 10 }, role: 'verified stamp' },
  { ground: 'stamp-returned', inks: { 'error': 4.5, 'ink': 10 }, role: 'returned stamp' },
  { ground: 'danger-hover', inks: { 'error': 4.5 }, role: 'danger button, hover' },
  { ground: 'danger-pressed', inks: { 'error': 4.5 }, role: 'danger button, pressed' }
]

/** Labels and glyphs drawn on solid fills. */
export const FILLS: Array<{ fg: string; bg: string; floor: number; role: string }> = [
  { fg: 'on-brass', bg: 'brass', floor: 7, role: 'primary button label' },
  { fg: 'on-brass', bg: 'brass-hover', floor: 7, role: 'primary button label, hover' },
  { fg: 'on-brass', bg: 'brass-pressed', floor: 7, role: 'primary button label, pressed' },
  { fg: 'on-mark', bg: 'mark', floor: 7, role: 'check glyph and switch knob' },
  { fg: 'on-error-fill', bg: 'error-fill', floor: 4.5, role: 'label on a solid error fill' },
  { fg: 'ink', bg: 'error-fill', floor: 3, role: 'window close icon on hover' },
  { fg: 'ink', bg: 'clip-video', floor: 7, role: 'video clip label' },
  { fg: 'ink', bg: 'clip-audio', floor: 7, role: 'audio clip label' },
  { fg: 'ink', bg: 'clip-overlay', floor: 7, role: 'overlay clip label' }
]

/** Washes used in flow outside the row states, with the bases they may sit on and the inks drawn on them. */
export const IN_FLOW_WASHES: Array<{ wash: string; bases: string[]; inks: Record<string, number>; role: string }> = [
  { wash: 'wash-running', bases: ['ground', 'panel'], inks: { 'ink': 10, 'ink-2': 7, 'running': 3 }, role: 'running banner' },
  { wash: 'wash-verified', bases: ['ground', 'panel'], inks: { 'ink': 10, 'ink-2': 7, 'verified': 3 }, role: 'verified banner' },
  { wash: 'wash-warning', bases: ['ground', 'panel'], inks: { 'ink': 10, 'ink-2': 7, 'warning': 3 }, role: 'warning banner' },
  { wash: 'wash-error', bases: ['ground', 'panel'], inks: { 'ink': 10, 'ink-2': 7, 'error': 3 }, role: 'error banner' },
  { wash: 'text-selection', bases: ['ground', 'panel', 'sunken', 'overlay'], inks: { 'ink': 4.5 }, role: 'selected text' },
  {
    wash: 'viz-band',
    bases: ['sunken'],
    inks: { 'viz-1': 3, 'viz-2': 3, 'viz-3': 3, 'viz-limit': 3, 'viz-ref': 3 },
    role: 'series and reference lines inside the tolerance band'
  }
]

/** Frames, boundaries, and graphics that need 3:1 against each side they touch. */
export const BOUNDARIES: Array<{ fg: string; surfaces: SurfaceSelector; role: string }> = [
  { fg: 'line-control', surfaces: 'all', role: 'control boundary' },
  { fg: 'line-control-hover', surfaces: 'all', role: 'control boundary, hover' },
  { fg: 'focus', surfaces: 'all', role: 'focus ring and caret' },
  { fg: 'brass', surfaces: 'selected', role: 'selection frame' },
  { fg: 'warning', surfaces: ['held-warning'], role: 'held warning frame, inside' },
  { fg: 'warning', surfaces: 'rows', role: 'held warning frame, outside' },
  { fg: 'error', surfaces: ['held-error'], role: 'held error frame, inside' },
  { fg: 'error', surfaces: 'rows', role: 'held error frame, outside' },
  { fg: 'verified', surfaces: ['stamp-verified'], role: 'verified stamp border, inside' },
  { fg: 'verified', surfaces: 'rows', role: 'verified stamp border, outside' },
  { fg: 'error', surfaces: ['stamp-returned'], role: 'returned stamp border, inside' },
  { fg: 'error', surfaces: 'rows', role: 'returned stamp border, outside' },
  { fg: 'error-fill', surfaces: ['raised', 'danger-hover', 'danger-pressed'], role: 'danger border, inside' },
  { fg: 'error-fill', surfaces: ['ground', 'panel', 'overlay'], role: 'danger border, outside; error icon' },
  { fg: 'line-control', surfaces: ['sunken'], role: 'progress frame around its sunken track' },
  { fg: 'ink-2', surfaces: ['sunken'], role: 'progress fill on its track' },
  { fg: 'scrollbar', surfaces: ['ground', 'panel', 'raised', 'overlay', 'rail', 'sunken'], role: 'scrollbar thumb' },
  { fg: 'scrollbar-hover', surfaces: ['ground', 'panel', 'raised', 'overlay', 'rail', 'sunken'], role: 'scrollbar thumb under the pointer' },
  { fg: 'scrollbar-active', surfaces: ['ground', 'panel', 'raised', 'overlay', 'rail', 'sunken'], role: 'scrollbar thumb while dragged' },
  { fg: 'mark', surfaces: ['ground', 'panel'], role: 'checked box, on switch track, slider thumb, tab underline' },
  { fg: 'mark', surfaces: ['line-control'], role: 'slider fill against its track' },
  { fg: 'brass', surfaces: ['sunken'], role: 'selected catalog number frame in its well' },
  { fg: 'viz-1', surfaces: ['sunken', 'panel', 'ground'], role: 'output series in the plot well; legend swatch' },
  { fg: 'viz-2', surfaces: ['sunken', 'panel', 'ground'], role: 'source series in the plot well; legend swatch' },
  { fg: 'viz-3', surfaces: ['sunken', 'panel', 'ground'], role: 'third series in the plot well; legend swatch' },
  { fg: 'viz-limit', surfaces: ['sunken'], role: 'tolerance band edges and ceiling line in the plot well' },
  { fg: 'viz-ref', surfaces: ['sunken'], role: 'target line in the plot well' },
  { fg: 'playhead', surfaces: ['ground'], role: 'timeline playhead' }
]

/** Pairs every series and status pair must keep apart, as OKLab distance x100 per vision type. */
export const SEPARATIONS: Array<{ a: string; b: string; normal: number; protan: number; deutan: number; tritan?: number }> = [
  { a: 'viz-1', b: 'viz-2', normal: 15, protan: 8, deutan: 8 },
  { a: 'viz-1', b: 'viz-3', normal: 15, protan: 8, deutan: 8 },
  { a: 'viz-2', b: 'viz-3', normal: 15, protan: 8, deutan: 8 },
  { a: 'verified', b: 'error', normal: 8, protan: 8, deutan: 8, tritan: 8 },
  { a: 'verified', b: 'warning', normal: 8, protan: 8, deutan: 8, tritan: 8 },
  { a: 'running', b: 'verified', normal: 8, protan: 8, deutan: 8, tritan: 8 }
]

/** Documented exemptions; each one states why it is safe. */
export const EXEMPTIONS: Exemption[] = [

  {
    tokens: ['ink-disabled'],
    reason: 'disabled controls only, which WCAG 1.4.3 exempts; never used on a focusable or selectable row; measured without a floor'
  },
  {
    tokens: ['scrim', 'walnut-400', 'walnut-500', 'walnut-700', 'rail-edge', 'line', 'line-strong', 'viz-band', 'viz-grid', 'viz-axis'],
    reason: 'decorative: backdrops, large walnut fills, the walnut accent fills of older pages, hairlines, region edges, the tolerance band fill, gridlines, and axes never identify a control or carry text'
  },
  {
    tokens: ['held-warning', 'held-error', 'stamp-verified', 'stamp-returned'],
    surfaces: 'rows',
    reason: 'a label ground is never measured against the row around it; its frame, icon, word, and hidden text carry the state'
  }
]

/**
 * Legacy text steps that screens still on the legacy classes draw text with, after the remap in
 * legacy-remap.css. Remove these declarations together with that file.
 */
export const LEGACY_TEXT: string[] = [
  'surface-50', 'surface-100', 'surface-200', 'surface-300', 'surface-400', 'surface-500', 'surface-600',
  'accent-100', 'accent-200', 'accent-300', 'accent-400', 'white',
  'red-300', 'red-400', 'rose-200', 'rose-400',
  'emerald-100', 'emerald-200', 'emerald-300', 'emerald-400', 'green-300', 'green-400',
  'amber-300', 'amber-400', 'yellow-400', 'orange-400',
  'blue-300', 'blue-400', 'sky-100', 'sky-200', 'sky-300', 'sky-400',
  'violet-100', 'violet-200', 'violet-300', 'violet-400', 'purple-300', 'purple-400'
]

/**
 * Legacy fills that carry text, with the hover and selection tints legacy rows use (a layer such as
 * `white/5` is a Tailwind alpha modifier). Text on surface-700 and on the light surface-500 and surface-600
 * fills is fixed at each call site instead.
 */
export const LEGACY_FILLS: Surface[] = [
  { name: 'surface-950', base: 'surface-950' },
  { name: 'surface-900', base: 'surface-900' },
  { name: 'surface-800', base: 'surface-800' },
  { name: 'surface-950 + white/5', base: 'surface-950', layer: 'white/5' },
  { name: 'surface-900 + white/5', base: 'surface-900', layer: 'white/5' },
  { name: 'surface-950 + accent-500/15', base: 'surface-950', layer: 'accent-500/15' },
  { name: 'surface-900 + accent-500/15', base: 'surface-900', layer: 'accent-500/15' }
]

/** Floor for legacy text on the legacy fills. */
export const LEGACY_TEXT_FLOOR = 4.5

/** Surface names for every base and state, for example `panel selected hover`. */
export function stateSurfaces(): Surface[]
{
  const out: Surface[] = []
  for (const { base, states } of BASE_STATES)
  {
    for (const [state, layer] of states)
    {
      out.push(layer ? { name: `${base} ${state}`, base, layer } : { name: base, base })
    }
  }
  return out
}

/** Resolves a surface selector to concrete surfaces; a name that is not a ground or state is an opaque token. */
export function selectSurfaces(selector: SurfaceSelector): Surface[]
{
  const all = stateSurfaces()
  if (selector === 'all') return all
  if (selector === 'selected') return all.filter((s) => s.layer === 'wash-selected' || s.layer === 'wash-selected-hover')
  if (selector === 'rows') return all.filter((s) => s.base === 'ground' || s.base === 'panel')
  return selector.map((name) => all.find((s) => s.name === name) ?? { name, base: name })
}

/** Every pair the test measures, generated from the declarations above. */
export function generatePairs(): Pair[]
{
  const pairs: Pair[] = []
  const surfaces = stateSurfaces()

  for (const [ink, floor] of Object.entries(TEXT_INKS))
  {
    for (const bg of surfaces) pairs.push({ fg: ink, bg, floor, role: 'text' })
  }

  for (const { ground, inks, role } of LABEL_GROUNDS)
  {
    for (const [ink, floor] of Object.entries(inks)) pairs.push({ fg: ink, bg: { name: ground, base: ground }, floor, role })
  }

  for (const { fg, bg, floor, role } of FILLS) pairs.push({ fg, bg: { name: bg, base: bg }, floor, role })

  for (const { wash, bases, inks, role } of IN_FLOW_WASHES)
  {
    for (const base of bases)
    {
      const bg = { name: `${base} + ${wash}`, base, layer: wash }
      for (const [ink, floor] of Object.entries(inks)) pairs.push({ fg: ink, bg, floor, role })
    }
  }

  for (const { fg, surfaces: selector, role } of BOUNDARIES)
  {
    for (const bg of selectSurfaces(selector)) pairs.push({ fg, bg, floor: 3, role })
  }

  return pairs
}

/** The surface-scoped exemption that covers a pair, if any. */
export function exemptionFor(pair: Pair): Exemption | undefined
{
  return EXEMPTIONS.find((e) => e.surfaces !== undefined && e.tokens.includes(pair.fg)
    && selectSurfaces(e.surfaces).some((s) => s.name === pair.bg.name))
}
