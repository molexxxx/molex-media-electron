/**
 * Style floor for the renderer source (src/renderer/src, every .ts, .tsx, and .css file).
 *
 * Everywhere: no text under 12 px (arbitrary Tailwind sizes, CSS and inline font sizes, canvas fonts), no
 * alpha-modified text colors, no focus outline suppression, and no new legacy opacity-0 range overlays.
 * In the primitives folder and every migrated folder: colors only through tokens, the three radii, no
 * legacy 2xs size, no gradients, glows, or blur, no title as a control's name, no disabled grid rows, no
 * transform transitions on the fast duration, and no important flags outside forced-colors blocks.
 * Violet literals left in legacy code and in the visualizer art may only fall. The theme itself keeps every
 * text size at 12 px or more, except the 11 px uppercase mono caption.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src')

/** The rebuilt Batch page: its frame and the folders of its regions, held to the strict rules from their first file. */
const BATCH_SCOPES = [
  'components/batch/BatchPage.tsx',
  'components/batch/page/',
  'components/batch/table/',
  'components/batch/toolbar/',
  'components/batch/header/',
  'components/batch/summary/',
  'components/batch/inspector/',
  'components/batch/history/'
]

/** The shell services built on the primitives: the close confirmation, the F6 region registry, and the zoom keys. */
const SHELL_SCOPES = [
  'components/layout/CloseConfirmModal.tsx',
  'hooks/useF6Region.ts',
  'hooks/useAppZoomKeys.ts'
]

/** Folders and files held to the strict rules; a folder joins once its components are built on the primitives. */
const STRICT_SCOPES = ['ui/', 'styles/primitives.css', ...BATCH_SCOPES, ...SHELL_SCOPES]

/** Legacy sliders that draw a fake track over a native range at opacity 0; the count may only fall. */
const LEGACY_RANGE_BASELINE = 10

/** Violet literals left in legacy components; the count may only fall, toward zero. */
const VIOLET_LEGACY_BASELINE = 8

/** Violet literals in the visualizer art, which keeps its own colors; the count may only fall. */
const VIOLET_ART_BASELINE = 7

const MIN_TEXT_PX = 12
const CAPTION_PX = 11

type RuleId =
  | 'text-size'
  | 'font-size'
  | 'canvas-font'
  | 'alpha-text'
  | 'outline'
  | 'palette'
  | 'color-literal'
  | 'text-2xs'
  | 'radius'
  | 'glow'
  | 'gradient'
  | 'blur'
  | 'title-name'
  | 'row-disabled'
  | 'fast-transform'
  | 'important'

interface SourceFile
{
  rel: string
  ext: string
  text: string
}

interface Hit
{
  index: number
  match: string
  context?: string
}

interface Violation extends Hit
{
  file: string
  line: number
  rule: RuleId
}

interface Exemption
{
  file: string
  rule: RuleId
  match: RegExp
  context?: string
  reason: string
}

/** Legacy rules kept on purpose, each with its reason. A stale entry fails the suite. */
const EXEMPTIONS: Exemption[] = [
  {
    file: 'styles/globals.css',
    rule: 'outline',
    match: /^outline: none$/,
    context: '.norm-slider',
    reason: 'Legacy normalize slider: its native range sits at opacity 0 under a drawn track, so an outline on it could never show; the base layer rings the range\'s parent on keyboard focus instead. Removed with the last legacy slider.'
  },
  {
    file: 'visualizations/rain.ts',
    rule: 'canvas-font',
    match: /^`(?:bold )?\$\{layerFont\}px monospace`$/,
    reason: 'Visualizer art that keeps its own drawing: the falling glyphs are decoration sized from the canvas, not text to read, so the text floor does not apply to them.'
  }
]

function walk(dir: string, out: string[] = []): string[]
{
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
  {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
    {
      walk(full, out)
    }
    else if (/\.(?:tsx?|css)$/.test(entry.name))
    {
      out.push(full)
    }
  }
  return out
}

function loadSources(): SourceFile[]
{
  return walk(ROOT).map((full) =>
  {
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    return { rel, ext: path.extname(full), text: fs.readFileSync(full, 'utf8') }
  })
}

function lineOf(text: string, index: number): number
{
  let line = 1
  for (let i = 0; i < index; i++)
  {
    if (text.charCodeAt(i) === 10)
    {
      line++
    }
  }
  return line
}

function* matches(text: string, pattern: RegExp): Generator<RegExpExecArray>
{
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)))
  {
    yield m
    if (m[0].length === 0)
    {
      re.lastIndex++
    }
  }
}

function toPx(value: number, unit: string): number
{
  return unit === 'px' ? value : value * 16
}

/** Names of the theme's text sizes, so `text-<size>/<n>` reads as a line-height modifier, not an alpha. */
function textSizeNames(): Set<string>
{
  const names = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'])
  for (const file of ['styles/tokens.css', 'styles/legacy-remap.css'])
  {
    const css = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const m of matches(css, /--text-([a-z0-9]+)\s*:/))
    {
      names.add(m[1])
    }
  }
  return names
}

const SIZE_NAMES = textSizeNames()

function smallTextClasses(text: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /(?<![\w-])text-\[(?:length:)?(\d*\.?\d+)(px|rem|em)\]/))
  {
    if (toPx(parseFloat(m[1]), m[2]) < MIN_TEXT_PX)
    {
      hits.push({ index: m.index, match: m[0] })
    }
  }
  return hits
}

function smallFontSizes(text: string, ext: string): Hit[]
{
  const hits: Hit[] = []
  const pattern = ext === '.css'
    ? /font-size\s*:\s*(\d*\.?\d+)(px|rem|em)\b/
    : /\bfontSize\s*:\s*['"`]?(\d*\.?\d+)(px|rem|em)?['"`]?/
  for (const m of matches(text, pattern))
  {
    if (toPx(parseFloat(m[1]), m[2] ?? 'px') < MIN_TEXT_PX)
    {
      hits.push({ index: m.index, match: m[0] })
    }
  }
  return hits
}

/** The text of a single-quoted, double-quoted, or interpolation-free template literal, or null. */
function quotedLiteral(source: string): string | null
{
  const m = /^(?:'([^'\n]*)'|"([^"\n]*)"|`([^`$]*)`)$/.exec(source)
  return m ? (m[1] ?? m[2] ?? m[3]) : null
}

/** Canvas font assignments whose size is below the floor or cannot be read from the source. */
function smallCanvasFonts(text: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /\.font\s*=\s*([^\n;]+)/))
  {
    const rhs = m[1].trim()
    let literal = quotedLiteral(rhs)
    if (literal === null && /^[A-Za-z_$][\w$]*$/.test(rhs))
    {
      const decl = new RegExp(`\\bconst\\s+${rhs.replace(/\$/g, '\\$')}\\s*=\\s*('[^'\\n]*'|"[^"\\n]*"|\`[^\`$]*\`)`).exec(text)
      literal = decl ? quotedLiteral(decl[1]) : null
    }
    const sizes = literal === null ? [] : [...matches(literal, /(\d*\.?\d+)px\b/)].map((s) => parseFloat(s[1]))
    if (literal === null || sizes.length === 0 || sizes.some((px) => px < MIN_TEXT_PX))
    {
      hits.push({ index: m.index, match: rhs })
    }
  }
  return hits
}

function alphaTextColors(text: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /(?<![\w-])text-([a-z][a-z0-9]*(?:-[a-z0-9]+)*|\[[^\]\s]+\])\/(\d+|\[[^\]\s]+\])(?![\w-])/))
  {
    const value = m[1]
    if (value.startsWith('['))
    {
      const inner = value.slice(1, -1)
      if (/^(?:length:)?\d*\.?\d+(?:px|rem|em|%)?$/.test(inner) || inner.startsWith('var(--text-'))
      {
        continue
      }
    }
    else if (SIZE_NAMES.has(value))
    {
      continue
    }
    hits.push({ index: m.index, match: m[0] })
  }
  return hits
}

/** Index ranges of every CSS block with its prelude, so a hit can name the selector or at-rule around it. */
function cssBlocks(css: string): Array<{ start: number, end: number, prelude: string }>
{
  const blocks: Array<{ start: number, end: number, prelude: string }> = []
  const stack: Array<{ start: number, prelude: string }> = []
  let segment = 0
  for (let i = 0; i < css.length; i++)
  {
    const c = css[i]
    if (c === '{')
    {
      stack.push({ start: i, prelude: css.slice(segment, i).trim() })
      segment = i + 1
    }
    else if (c === '}')
    {
      const open = stack.pop()
      if (open)
      {
        blocks.push({ start: open.start, end: i, prelude: open.prelude })
      }
      segment = i + 1
    }
    else if (c === ';')
    {
      segment = i + 1
    }
  }
  return blocks
}

function enclosing(blocks: Array<{ start: number, end: number, prelude: string }>, index: number): string[]
{
  return blocks
    .filter((b) => b.start < index && index < b.end)
    .sort((a, b) => b.start - a.start)
    .map((b) => b.prelude)
}

function stripCssComments(css: string): string
{
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

function outlineSuppression(text: string, ext: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /(?<![\w-])(?:[\w-]+:)*outline-(?:none|hidden|0)(?![\w-])/))
  {
    hits.push({ index: m.index, match: m[0] })
  }
  if (ext === '.css')
  {
    const css = stripCssComments(text)
    const blocks = cssBlocks(css)
    for (const m of matches(css, /\boutline(?:-style|-width)?\s*:\s*(?:none|0)(?![\w.])/))
    {
      hits.push({ index: m.index, match: m[0], context: enclosing(blocks, m.index)[0] })
    }
  }
  else
  {
    for (const m of matches(text, /\boutline(?:Style|Width)?\s*:\s*(?:'none'|"none"|'0'|"0"|0(?![\w.]))/))
    {
      hits.push({ index: m.index, match: m[0] })
    }
  }
  return hits
}

const HUES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe'
const COLOR_UTILITIES = 'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|shadow|inset-shadow|drop-shadow|divide|accent|caret|decoration|placeholder'
const PALETTE_PATTERN = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?:${COLOR_UTILITIES})-(?:(?:${HUES}|surface|accent)-\\d{2,3}|white|black)(?![\\w-])`)

function paletteClasses(text: string): Hit[]
{
  return [...matches(text, PALETTE_PATTERN)].map((m) => ({ index: m.index, match: m[0] }))
}

function colorLiterals(text: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/))
  {
    hits.push({ index: m.index, match: m[0] })
  }
  for (const m of matches(text, /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/))
  {
    hits.push({ index: m.index, match: m[0] })
  }
  return hits
}

function legacyTwoXs(text: string): Hit[]
{
  return [...matches(text, /(?<![\w-])(?:[\w-]+:)*text-2xs(?![\w-])/)].map((m) => ({ index: m.index, match: m[0] }))
}

const RADIUS_SIDES = new Set(['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'br', 'bl', 'ss', 'se', 'es', 'ee'])
const RADIUS_SIZES = new Set(['xs', 'sm', 'md', 'none'])

function radiusOutsideScale(text: string): Hit[]
{
  const hits: Hit[] = []
  for (const m of matches(text, /(?<![\w-])(?:[\w-]+:)*rounded(?:-[\w.]+|-\[[^\]]*\])*(?![\w-])/))
  {
    const token = m[0].slice(m[0].lastIndexOf('rounded'))
    const parts = token.split('-').slice(1)
    if (parts.length > 0 && RADIUS_SIDES.has(parts[0]))
    {
      parts.shift()
    }
    if (parts.length !== 1 || !RADIUS_SIZES.has(parts[0]))
    {
      hits.push({ index: m.index, match: m[0] })
    }
  }
  return hits
}

function glowShadows(text: string): Hit[]
{
  return [...matches(text, /(?<![\w-])(?:[\w-]+:)*shadow-(?:glow(?:-lg)?|inner-glow)(?![\w-])/)].map((m) => ({ index: m.index, match: m[0] }))
}

function gradientUtilities(text: string): Hit[]
{
  return [...matches(text, /(?<![\w-])(?:[\w-]+:)*bg-(?:gradient-to-|linear-|radial|conic)[\w\-[\]/.%()]*/)].map((m) => ({ index: m.index, match: m[0] }))
}

function backdropBlur(text: string): Hit[]
{
  return [...matches(text, /(?<![\w-])(?:[\w-]+:)*backdrop-blur[\w\-[\]]*/)].map((m) => ({ index: m.index, match: m[0] }))
}

/** JSX opening tags, read with quotes and braces balanced so arrow functions and strings do not end them. */
function openingTags(text: string): Array<{ index: number, name: string, source: string }>
{
  const tags: Array<{ index: number, name: string, source: string }> = []
  for (const m of matches(text, /<([A-Za-z][\w.]*)(?=[\s/>])/))
  {
    let depth = 0
    let quote: string | null = null
    let i = m.index + m[0].length
    for (; i < text.length; i++)
    {
      const c = text[i]
      if (quote)
      {
        if (c === '\\')
        {
          i++
        }
        else if (c === quote)
        {
          quote = null
        }
        continue
      }
      if (c === '"' || c === '\'' || c === '`')
      {
        quote = c
      }
      else if (c === '{')
      {
        depth++
      }
      else if (c === '}')
      {
        depth--
      }
      else if (c === '>' && depth === 0)
      {
        break
      }
    }
    tags.push({ index: m.index, name: m[1], source: text.slice(m.index, i + 1) })
  }
  return tags
}

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'Button', 'IconButton'])
const INTERACTIVE_ROLE = /\brole=(?:"|'|\{['"])(?:button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|switch|option|slider|spinbutton|combobox|gridcell|row)\b/

function titleAsName(text: string): Hit[]
{
  return openingTags(text)
    .filter((tag) => INTERACTIVE_TAGS.has(tag.name) || INTERACTIVE_ROLE.test(tag.source) || /\s(?:onClick|tabIndex)=/.test(tag.source))
    .filter((tag) => /\stitle=/.test(tag.source))
    .map((tag) => ({ index: tag.index, match: `<${tag.name} title=...>` }))
}

function disabledRows(text: string): Hit[]
{
  return openingTags(text)
    .filter((tag) => /\brole=(?:"row"|'row'|\{['"]row['"]\})/.test(tag.source) && /\saria-disabled\b/.test(tag.source))
    .map((tag) => ({ index: tag.index, match: `<${tag.name} role="row" aria-disabled>` }))
}

function stringLiterals(text: string): Array<{ index: number, value: string }>
{
  return [...matches(text, /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/)].map((m) => ({ index: m.index, value: m[0].slice(1, -1) }))
}

const TRANSFORM_TRANSITION = /(?<![\w-])(?:[\w-]+:)*transition(?:-all|-transform|-\[[^\]]*(?:transform|translate|scale)[^\]]*\])?(?![\w-])/
const FAST_DURATION = /(?<![\w-])(?:[\w-]+:)*duration-fast(?![\w-])/

function fastTransforms(text: string, ext: string): Hit[]
{
  const hits: Hit[] = []
  if (ext === '.css')
  {
    const css = stripCssComments(text)
    for (const m of matches(css, /\btransition\s*:\s*([^;}]+)/))
    {
      for (const part of m[1].split(','))
      {
        if (/\b(?:transform|translate|scale|all)\b/.test(part) && /--transition-duration-fast\b/.test(part))
        {
          hits.push({ index: m.index, match: part.trim() })
        }
      }
    }
    for (const block of cssBlocks(css))
    {
      const body = css.slice(block.start + 1, block.end)
      const property = /transition-property\s*:\s*([^;}]+)/.exec(body)
      const duration = /transition-duration\s*:\s*([^;}]+)/.exec(body)
      if (property && duration && /\b(?:transform|translate|scale|all)\b/.test(property[1]) && /--transition-duration-fast\b/.test(duration[1]))
      {
        hits.push({ index: block.start, match: `${property[0].trim()}; ${duration[0].trim()}` })
      }
    }
    return hits
  }
  for (const literal of stringLiterals(text))
  {
    if (TRANSFORM_TRANSITION.test(literal.value) && FAST_DURATION.test(literal.value))
    {
      hits.push({ index: literal.index, match: literal.value })
    }
  }
  return hits
}

function importantFlags(text: string, ext: string): Hit[]
{
  const hits: Hit[] = []
  if (ext === '.css')
  {
    const css = stripCssComments(text)
    const blocks = cssBlocks(css)
    for (const m of matches(css, /!important\b/))
    {
      const inForcedColors = enclosing(blocks, m.index).some((prelude) => /^@media[^{]*forced-colors\s*:\s*active/.test(prelude))
      if (!inForcedColors)
      {
        hits.push({ index: m.index, match: m[0], context: enclosing(blocks, m.index)[0] })
      }
    }
    return hits
  }
  for (const literal of stringLiterals(text))
  {
    for (const token of literal.value.split(/\s+/))
    {
      if (/^![a-z]/.test(token) || /^[a-z][\w:[\]/.%()-]*-[\w:[\]/.%()-]*!$/.test(token))
      {
        hits.push({ index: literal.index, match: token })
      }
    }
  }
  return hits
}

const VIOLET = /124,\s?58,\s?237|139,\s?92,\s?246|168,\s?85,\s?247|#7c3aed|#8b5cf6|#a78bfa|#c4b5fd|#9470ff/gi

function violetCount(text: string): number
{
  return [...matches(text, VIOLET)].length
}

function legacyRangeCount(text: string): number
{
  return openingTags(text)
    .filter((tag) => tag.name === 'input' && /\btype=["']range["']/.test(tag.source))
    .filter((tag) => /(?:^|[\s"'`{])(?:opacity-0|norm-slider)(?=[\s"'`}]|$)/m.test(tag.source))
    .length
}

function isStrict(rel: string): boolean
{
  return STRICT_SCOPES.some((scope) => scope.endsWith('/') ? rel.startsWith(scope) : rel === scope)
}

function scan(files: SourceFile[]): Violation[]
{
  const out: Violation[] = []
  const add = (file: SourceFile, rule: RuleId, hits: Hit[]): void =>
  {
    for (const hit of hits)
    {
      out.push({ ...hit, file: file.rel, rule, line: lineOf(file.text, hit.index) })
    }
  }
  for (const file of files)
  {
    const code = file.ext !== '.css'
    add(file, 'text-size', smallTextClasses(file.text))
    add(file, 'font-size', smallFontSizes(file.text, file.ext))
    if (code)
    {
      add(file, 'canvas-font', smallCanvasFonts(file.text))
    }
    add(file, 'alpha-text', alphaTextColors(file.text))
    add(file, 'outline', outlineSuppression(file.text, file.ext))
    if (!isStrict(file.rel))
    {
      continue
    }
    add(file, 'palette', paletteClasses(file.text))
    add(file, 'color-literal', colorLiterals(file.text))
    add(file, 'text-2xs', legacyTwoXs(file.text))
    add(file, 'radius', radiusOutsideScale(file.text))
    add(file, 'glow', glowShadows(file.text))
    add(file, 'gradient', gradientUtilities(file.text))
    add(file, 'blur', backdropBlur(file.text))
    if (code)
    {
      add(file, 'title-name', titleAsName(file.text))
      add(file, 'row-disabled', disabledRows(file.text))
    }
    add(file, 'fast-transform', fastTransforms(file.text, file.ext))
    add(file, 'important', importantFlags(file.text, file.ext))
  }
  return out
}

function exemptionFor(violation: Violation): Exemption | undefined
{
  return EXEMPTIONS.find((e) => e.file === violation.file && e.rule === violation.rule && e.match.test(violation.match) && (e.context === undefined || e.context === violation.context))
}

function describeViolation(v: Violation): string
{
  return `${v.file}:${v.line} [${v.rule}] ${v.match}${v.context ? ` (in ${v.context})` : ''}`
}

const SOURCES = loadSources()
const VIOLATIONS = scan(SOURCES)

describe('style floor', () =>
{
  it('scans the whole renderer source, including the primitives', () =>
  {
    const rels = SOURCES.map((f) => f.rel)
    expect(rels.length).toBeGreaterThan(100)
    expect(rels).toContain('ui/Button.tsx')
    expect(rels).toContain('styles/globals.css')
    expect(rels.filter(isStrict)).toContain('ui/cx.ts')
  })

  it('holds the rebuilt Batch page to the strict rules and leaves the legacy batch files to the ratchets', () =>
  {
    for (const rel of ['components/batch/BatchPage.tsx', 'components/batch/page/Frame.tsx', 'components/batch/table/JobTable.tsx', 'components/batch/toolbar/Toolbar.tsx', 'components/batch/header/RunHeader.tsx', 'components/batch/summary/Summary.tsx', 'components/batch/inspector/Inspector.tsx', 'components/batch/history/History.tsx'])
    {
      expect(isStrict(rel), rel).toBe(true)
    }
    for (const rel of ['components/batch/FileQueue.tsx', 'components/batch/ProcessingView.tsx', 'components/batch/components/QueueList.tsx', 'components/batch/BatchPage.test.tsx', 'components/batch/pageant/x.tsx'])
    {
      expect(isStrict(rel), rel).toBe(false)
    }
    expect(SOURCES.map((f) => f.rel).filter(isStrict)).toContain('components/batch/table/cells.tsx')
  })

  it('holds the shell services to the strict rules and leaves the legacy shell files to the ratchets', () =>
  {
    for (const rel of SHELL_SCOPES)
    {
      expect(isStrict(rel), rel).toBe(true)
      expect(SOURCES.map((f) => f.rel), rel).toContain(rel)
    }
    for (const rel of ['components/layout/Sidebar.tsx', 'components/layout/TitleBar.tsx', 'hooks/useIPC.ts', 'App.tsx', 'hooks/useF6Region.test.ts'])
    {
      expect(isStrict(rel), rel).toBe(false)
    }
  })

  it('finds no violation outside the listed exemptions', () =>
  {
    const open = VIOLATIONS.filter((v) => !exemptionFor(v)).map(describeViolation)
    expect(open, `style floor violations:\n${open.join('\n')}`).toEqual([])
  })

  it('keeps every exemption reasoned and still needed', () =>
  {
    for (const exemption of EXEMPTIONS)
    {
      expect(exemption.reason.length).toBeGreaterThan(40)
      const used = VIOLATIONS.some((v) => exemptionFor(v) === exemption)
      expect(used, `stale exemption: ${exemption.file} [${exemption.rule}] ${exemption.match}`).toBe(true)
    }
  })

  it('lets the legacy opacity-0 range overlays only fall', () =>
  {
    const count = SOURCES.filter((f) => f.ext === '.tsx').reduce((n, f) => n + legacyRangeCount(f.text), 0)
    expect(count).toBeLessThanOrEqual(LEGACY_RANGE_BASELINE)
  })

  it('lets the violet literals only fall, in legacy code and in the visualizer art', () =>
  {
    const art = SOURCES.filter((f) => f.rel.startsWith('visualizations/')).reduce((n, f) => n + violetCount(f.text), 0)
    const legacy = SOURCES.filter((f) => !f.rel.startsWith('visualizations/')).reduce((n, f) => n + violetCount(f.text), 0)
    expect(legacy).toBeLessThanOrEqual(VIOLET_LEGACY_BASELINE)
    expect(art).toBeLessThanOrEqual(VIOLET_ART_BASELINE)
    expect(SOURCES.filter((f) => isStrict(f.rel)).reduce((n, f) => n + violetCount(f.text), 0)).toBe(0)
  })

  it('keeps every theme text size at 12 px or more, except the 11 px caption', () =>
  {
    for (const file of ['styles/tokens.css', 'styles/legacy-remap.css'])
    {
      const css = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const m of matches(css, /--text-([a-z0-9]+)\s*:\s*(\d*\.?\d+)(rem|px)\s*;/))
      {
        const px = toPx(parseFloat(m[2]), m[3])
        if (m[1] === 'caption')
        {
          expect(px).toBe(CAPTION_PX)
        }
        else
        {
          expect(px, `${file} --text-${m[1]}`).toBeGreaterThanOrEqual(MIN_TEXT_PX)
        }
      }
    }
  })

  it('ties the 11 px size to the uppercase legend and sets the UI in the platform face', () =>
  {
    const tokens = fs.readFileSync(path.join(ROOT, 'styles/tokens.css'), 'utf8')
    const legend = /@utility type-legend\s*\{([^}]*)\}/.exec(tokens)
    const caption = /@utility type-caption\s*\{([^}]*)\}/.exec(tokens)
    expect(legend).not.toBeNull()
    expect(legend![1]).toMatch(/font-size:\s*var\(--text-caption\)/)
    expect(legend![1]).toMatch(/text-transform:\s*uppercase/)
    expect(caption).not.toBeNull()
    expect(caption![1]).toMatch(/font-size:\s*var\(--text-label\)/)
    expect(caption![1]).not.toMatch(/uppercase/)
    expect(tokens).toMatch(/--font-sans:\s*'Segoe UI Variable Text'/)
    expect(tokens).toMatch(/--font-mono:\s*'Cascadia Mono'/)
    expect(tokens).not.toMatch(/@font-face/)
  })
})

describe('style floor detectors', () =>
{
  it('flags arbitrary text sizes under 12 px and passes the rest', () =>
  {
    expect(smallTextClasses('a text-[10px] b md:text-[11.5px] text-[0.7rem]').map((h) => h.match)).toEqual(['text-[10px]', 'text-[11.5px]', 'text-[0.7rem]'])
    expect(smallTextClasses('text-[12px] text-[0.75rem] text-label context-[9px]')).toEqual([])
  })

  it('flags small CSS and inline font sizes', () =>
  {
    expect(smallFontSizes('.a { font-size: 10px; } .b { font-size: 0.875rem; }', '.css').map((h) => h.match)).toEqual(['font-size: 10px'])
    expect(smallFontSizes('style={{ fontSize: 9 }} style={{ fontSize: \'14px\' }} fontSize: number', '.tsx').map((h) => h.match)).toEqual(['fontSize: 9'])
  })

  it('reads canvas font sizes from literals and file constants, and flags what it cannot read', () =>
  {
    const source = [
      'const LABEL = \'12px "JetBrains Mono", monospace\'',
      'const TINY = \'bold 8px monospace\'',
      'ctx.font = LABEL',
      'ctx.font = TINY',
      'ctx.font = \'10px ui-monospace\'',
      'ctx.font = `${size}px monospace`',
      'ctx.font = \'14px sans-serif\''
    ].join('\n')
    expect(smallCanvasFonts(source).map((h) => h.match)).toEqual(['TINY', '\'10px ui-monospace\'', '`${size}px monospace`'])
  })

  it('flags alpha-modified text colors but not line-height modifiers on sizes', () =>
  {
    const hits = alphaTextColors('text-white/70 hover:text-red-400/80 text-[#fff]/50 text-sm/6 text-label/5 text-[13px]/5 bg-white/5 text-ink border-white/10')
    expect(hits.map((h) => h.match)).toEqual(['text-white/70', 'text-red-400/80', 'text-[#fff]/50'])
  })

  it('flags outline suppression in classes, stylesheets, and inline styles', () =>
  {
    expect(outlineSuppression('a outline-none focus:outline-none focus-visible:outline-hidden outline-0 -outline-offset-2 outline-offset-0', '.tsx').map((h) => h.match))
      .toEqual(['outline-none', 'focus:outline-none', 'focus-visible:outline-hidden', 'outline-0'])
    expect(outlineSuppression('style={{ outline: \'none\' }}', '.tsx').map((h) => h.match)).toEqual(['outline: \'none\''])
    const css = outlineSuppression('.ring { outline: 2px solid red; } .x:focus { outline: none; }', '.css')
    expect(css.map((h) => [h.match, h.context])).toEqual([['outline: none', '.x:focus']])
  })

  it('flags default palette, white, black, and legacy ramp colors in strict code', () =>
  {
    const hits = paletteClasses('bg-red-500 hover:text-sky-300/50 border-white/5 text-black accent-accent-500 bg-surface-900 bg-brass text-ink accent-mark border-line-control')
    expect(hits.map((h) => h.match)).toEqual(['bg-red-500', 'hover:text-sky-300', 'border-white', 'text-black', 'accent-accent-500', 'bg-surface-900'])
  })

  it('flags color literals but not token references', () =>
  {
    expect(colorLiterals('#7c3aed #fff rgba(0, 0, 0, 0.2) hsl(210 50% 50%) oklch(0.8 0.1 140)').map((h) => h.match)).toEqual(['#7c3aed', '#fff', 'rgba(', 'hsl(', 'oklch('])
    expect(colorLiterals('var(--color-brass) color-mix(in oklab, var(--color-ink) 5%, transparent) #popout')).toEqual([])
  })

  it('allows only the three radii', () =>
  {
    const hits = radiusOutsideScale('rounded-xs rounded-sm rounded-md rounded-none rounded-t-sm rounded rounded-lg rounded-full rounded-l-xl rounded-[3px]')
    expect(hits.map((h) => h.match)).toEqual(['rounded', 'rounded-lg', 'rounded-full', 'rounded-l-xl', 'rounded-[3px]'])
  })

  it('flags the legacy size, glows, gradients, and blur', () =>
  {
    expect(legacyTwoXs('text-2xs sm:text-2xs text-xs').map((h) => h.match)).toEqual(['text-2xs', 'sm:text-2xs'])
    expect(glowShadows('shadow-glow shadow-glow-lg hover:shadow-inner-glow shadow-overlay').map((h) => h.match)).toEqual(['shadow-glow', 'shadow-glow-lg', 'hover:shadow-inner-glow'])
    expect(gradientUtilities('bg-gradient-to-r bg-linear-to-t bg-radial bg-panel').map((h) => h.match)).toEqual(['bg-gradient-to-r', 'bg-linear-to-t', 'bg-radial'])
    expect(backdropBlur('backdrop-blur backdrop-blur-sm blur-sm').map((h) => h.match)).toEqual(['backdrop-blur', 'backdrop-blur-sm'])
  })

  it('flags title on interactive elements and disabled rows', () =>
  {
    const tsx = [
      '<button title="Close" onClick={() => close(a > b)}>x</button>',
      '<span title="Full path">p</span>',
      '<div role="row" aria-disabled="true" />',
      '<div role="row" aria-selected={selected} />',
      '<div onClick={open} title="Open" />'
    ].join('\n')
    expect(titleAsName(tsx).map((h) => h.match)).toEqual(['<button title=...>', '<div title=...>'])
    expect(disabledRows(tsx).map((h) => h.match)).toEqual(['<div role="row" aria-disabled>'])
  })

  it('flags transform transitions on the fast duration', () =>
  {
    expect(fastTransforms('const a = \'transition-transform duration-fast\'; const b = \'transition-colors duration-fast\'; const c = \'transition-transform duration-move\'', '.tsx').map((h) => h.match))
      .toEqual(['transition-transform duration-fast'])
    const css = '.k { transition: transform var(--transition-duration-fast) var(--ease-out), background-color var(--transition-duration-fast); } .m { transition: transform var(--transition-duration-move); } .p { transition-property: translate; transition-duration: var(--transition-duration-fast); }'
    expect(fastTransforms(css, '.css').map((h) => h.match)).toEqual(['transform var(--transition-duration-fast) var(--ease-out)', 'transition-property: translate; transition-duration: var(--transition-duration-fast)'])
  })

  it('allows important flags only inside forced-colors blocks', () =>
  {
    const css = '@media (forced-colors: active) { .a { color: CanvasText !important; } } .b { color: red !important; }'
    expect(importantFlags(css, '.css').map((h) => [h.match, h.context])).toEqual([['!important', '.b']])
    expect(importantFlags('const c = \'!bg-panel text-ink hover:bg-raised! Done!\'', '.tsx').map((h) => h.match)).toEqual(['!bg-panel', 'hover:bg-raised!'])
  })

  it('counts legacy ranges and violet literals', () =>
  {
    const tsx = '<input type="range" className="absolute inset-0 opacity-0" onChange={(e) => set(e.target.value > 1)} /><input type="range" className="ui-slider" /><input className="norm-slider" type=\'range\' />'
    expect(legacyRangeCount(tsx)).toBe(2)
    expect(violetCount('rgba(124, 58, 237, 0.6) #7C3AED rgba(139,92,246,1)')).toBe(3)
  })
})
