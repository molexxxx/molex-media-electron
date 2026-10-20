/**
 * The naming template: every token, segments and an empty {subdir}, sanitizing that is the same on every platform,
 * Windows device names, truncation at a byte limit, refusals for unknown tokens, empty stems, '..', and full paths,
 * and % doubled in frame sequence paths so FFmpeg's image2 muxer reads them literally.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_SEGMENT_BYTES,
  escapePercent,
  frameSequencePattern,
  parseTemplate,
  pathSeparator,
  renderTemplate,
  sanitizeSegments,
  stemOf,
  templateDate,
  templateValues,
  truncateSegment,
  unknownTokens,
  type TemplateValues
} from '../../../src/shared/jobs/template'
import { TEMPLATE_TOKENS, DEFAULT_TEMPLATES } from '../../../src/shared/jobs/types'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { Platform } from '../../../src/shared/text/platform'

const VALUES: TemplateValues =
{
  name: 'episode 142',
  ext: 'mkv',
  op: 'normalize',
  preset: 'streaming-r128s2',
  catalog: 'MM-0142',
  date: '2026-10-16',
  subdir: 'Season 1/Extras'
}

const PLATFORMS: Platform[] = ['win32', 'linux', 'darwin']

function render(template: string, values: Partial<TemplateValues> = {}, platform: Platform = 'linux'): ReturnType<typeof renderTemplate>
{
  return renderTemplate(template, { ...VALUES, ...values }, platform)
}

function codes(template: string, values: Partial<TemplateValues> = {}): string[]
{
  return render(template, values).issues.map((issue) => issue.code)
}

describe('tokens', () =>
{
  it.each([
    ['{name}', 'episode 142'],
    ['{ext}', 'mkv'],
    ['{op}', 'normalize'],
    ['{preset}', 'streaming-r128s2'],
    ['{catalog}', 'MM-0142'],
    ['{date}', '2026-10-16'],
    ['{name}-{op}', 'episode 142-normalize'],
    ['{catalog} {name}.{ext}', 'MM-0142 episode 142.mkv']
  ])('%s renders %s', (template, stem) =>
  {
    const result = render(template)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.segments).toEqual([stem])
  })

  it('knows exactly the seven tokens and the default templates use them', () =>
  {
    expect([...TEMPLATE_TOKENS]).toEqual(['name', 'ext', 'op', 'preset', 'catalog', 'date', 'subdir'])
    expect(render(DEFAULT_TEMPLATES.folder).segments).toEqual(['episode 142'])
    expect(render(DEFAULT_TEMPLATES['next-to-source']).segments).toEqual(['episode 142-normalize'])
  })

  it('fills the tokens from a job: the {op} word and the {preset} slug', () =>
  {
    const job = (recipe: Recipe): TemplateValues => templateValues({ catalog: 'MM-0007', stem: 'take 3', ext: 'wav', subdir: '', recipe, date: '2026-01-02' })
    const normalize = applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' })
    expect(job(normalize)).toEqual({ name: 'take 3', ext: 'wav', op: 'normalize', preset: 'ebu-r128', catalog: 'MM-0007', date: '2026-01-02', subdir: '' })
    expect(job(applyGainPreset('gentle-lift', { kind: 'same-as-source' })).op).toBe('gain')
    expect(job({ ...normalize, userPreset: { id: 'u1', name: 'Late Podcasts!' } }).preset).toBe('late-podcasts')
    expect(job({ ...normalize, presetId: 'custom' }).preset).toBe('custom')
  })

  it('takes the stem and the local date the tokens need', () =>
  {
    expect(stemOf('episode.142.mkv')).toBe('episode.142')
    expect(stemOf('.hidden')).toBe('.hidden')
    expect(stemOf('noext')).toBe('noext')
    expect(templateDate(new Date(2026, 9, 16, 12, 30).getTime())).toBe('2026-10-16')
    expect(templateDate(new Date(2027, 0, 5, 0, 0).getTime())).toBe('2027-01-05')
  })
})

describe('segments', () =>
{
  it('splits on / and \\ in the template text', () =>
  {
    expect(render('{op}/{name}').segments).toEqual(['normalize', 'episode 142'])
    expect(render('{op}\\{date}\\{name}').segments).toEqual(['normalize', '2026-10-16', 'episode 142'])
  })

  it('lets {subdir} carry folders and collapses it when empty', () =>
  {
    expect(render('{subdir}/{name}').segments).toEqual(['Season 1', 'Extras', 'episode 142'])
    expect(render('{subdir}/{name}', { subdir: 'Season 1\\Extras' }).segments).toEqual(['Season 1', 'Extras', 'episode 142'])
    const single = render('{subdir}/{name}', { subdir: '' })
    expect(single.segments).toEqual(['episode 142'])
    expect(single.issues).toEqual([])
  })

  it('collapses empty and dot segments', () =>
  {
    expect(render('out//{name}').segments).toEqual(['out', 'episode 142'])
    expect(render('./{name}').segments).toEqual(['episode 142'])
    expect(render('./{name}').issues).toEqual([])
  })

  it('never lets a token value other than {subdir} make a folder', () =>
  {
    const result = render('{preset}/{name}', { name: 'a/b\\c', preset: 'x/y' })
    expect(result.segments).toEqual(['x_y', 'a_b_c'])
    expect(result.issues.map((issue) => issue.code)).toEqual(['template-sanitized'])
  })

  it('parses text, tokens, and unknown tokens in order', () =>
  {
    expect(parseTemplate('{name} - {album} ({ext})')).toEqual([
      { kind: 'token', token: 'name' },
      { kind: 'text', text: ' - ' },
      { kind: 'unknown', text: '{album}' },
      { kind: 'text', text: ' (' },
      { kind: 'token', token: 'ext' },
      { kind: 'text', text: ')' }
    ])
    expect(parseTemplate('plain {} text')).toEqual([{ kind: 'text', text: 'plain {} text' }])
  })
})

describe('sanitizing', () =>
{
  it.each(PLATFORMS)('replaces the same characters with _ on %s', (platform) =>
  {
    const result = render('{subdir}/{name}', { subdir: 'a<b>c', name: 'x:y"z|w?v*u\u0001t\u007f' }, platform)
    expect(result.segments).toEqual(['a_b_c', 'x_y_z_w_v_u_t_'])
    expect(result.relativePath).toBe(['a_b_c', 'x_y_z_w_v_u_t_'].join(pathSeparator(platform)))
    expect(result.issues).toEqual([{ code: 'template-sanitized', severity: 'warning', message: 'Characters that file names cannot hold were replaced with _.' }])
    expect(result.ok).toBe(true)
  })

  it.each(PLATFORMS)('trims trailing dots and spaces on %s', (platform) =>
  {
    const result = render('{name}. . ', { name: 'take' }, platform)
    expect(result.segments).toEqual(['take'])
    expect(result.issues.map((issue) => issue.message)).toEqual(['Dots and spaces at the end of a name were removed.'])
    expect(render(' {name}', { name: 'lead' }, platform).segments).toEqual([' lead'])
  })

  it('joins segments with the platform separator', () =>
  {
    expect(render('{op}/{name}', {}, 'win32').relativePath).toBe('normalize\\episode 142')
    expect(render('{op}/{name}', {}, 'linux').relativePath).toBe('normalize/episode 142')
    expect(render('{op}/{name}', {}, 'darwin').relativePath).toBe('normalize/episode 142')
  })

  it('reports each kind of change once', () =>
  {
    const result = sanitizeSegments(['a?', 'b*', 'c. ', 'NUL', 'x'.repeat(MAX_SEGMENT_BYTES + 1)])
    expect(result.segments).toEqual(['a_', 'b_', 'c', 'NUL_', 'x'.repeat(MAX_SEGMENT_BYTES)])
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'Characters that file names cannot hold were replaced with _.',
      'Dots and spaces at the end of a name were removed.',
      'NUL is a reserved name on Windows, so the name ends with _.',
      `A name longer than ${MAX_SEGMENT_BYTES} bytes was shortened.`
    ])
  })
})

describe('device names', () =>
{
  it.each([
    ['CON', 'CON_'], ['con', 'con_'], ['PRN', 'PRN_'], ['AUX', 'AUX_'], ['NUL', 'NUL_'], ['COM1', 'COM1_'], ['com9', 'com9_'],
    ['LPT1', 'LPT1_'], ['LPT9', 'LPT9_'], ['CON.backup', 'CON_.backup'], ['nul.tar', 'nul_.tar'], ['AUX. ', 'AUX_']
  ])('%s becomes %s on every platform', (name, expected) =>
  {
    for (const platform of PLATFORMS)
    {
      const result = render('{name}', { name }, platform)
      expect(result.segments, platform).toEqual([expected])
      expect(result.issues.some((issue) => issue.message.endsWith('is a reserved name on Windows, so the name ends with _.'))).toBe(true)
    }
  })

  it.each(['COM10', 'LPT0', 'CONSOLE', 'CONN', 'icon', 'nullable', 'COM'])('%s is not a device name', (name) =>
  {
    expect(render('{name}', { name }).segments).toEqual([name])
    expect(render('{name}', { name }).issues).toEqual([])
  })

  it('suffixes a device name in a folder segment too', () =>
  {
    expect(render('{subdir}/{name}', { subdir: 'PRN', name: 'a' }).segments).toEqual(['PRN_', 'a'])
  })
})

describe('truncation', () =>
{
  it('cuts a segment to 200 UTF-8 bytes', () =>
  {
    const result = render('{name}', { name: 'a'.repeat(250) })
    expect(result.segments).toEqual(['a'.repeat(200)])
    expect(result.issues.map((issue) => issue.message)).toEqual(['A name longer than 200 bytes was shortened.'])
  })

  it('counts bytes, not characters, and never splits a character', () =>
  {
    expect(truncateSegment('\u00e9'.repeat(150))).toBe('\u00e9'.repeat(100))
    expect(truncateSegment('\u20ac'.repeat(100))).toBe('\u20ac'.repeat(66))
    expect(truncateSegment('\u{1f3b5}'.repeat(60))).toBe('\u{1f3b5}'.repeat(50))
    expect(truncateSegment(`a${'\u{1f3b5}'.repeat(50)}`)).toBe(`a${'\u{1f3b5}'.repeat(49)}`)
    expect(truncateSegment('short')).toBe('short')
    expect(truncateSegment('abcdef', 3)).toBe('abc')
  })

  it('trims a space or dot left at the cut', () =>
  {
    expect(render('{name}', { name: `${'a'.repeat(199)} tail` }).segments).toEqual(['a'.repeat(199)])
  })

  it('keeps a segment of exactly 200 bytes', () =>
  {
    expect(render('{name}', { name: 'b'.repeat(200) }).issues).toEqual([])
  })
})

describe('refusals', () =>
{
  it('refuses unknown tokens, naming each once', () =>
  {
    const result = render('{name} {album} {Name} {album}')
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      { code: 'template-unknown-token', severity: 'error', message: 'Unknown token {album} in the file name.' },
      { code: 'template-unknown-token', severity: 'error', message: 'Unknown token {Name} in the file name.' }
    ])
    expect(unknownTokens('{track}{name}{track}')).toEqual(['{track}'])
  })

  it.each(['..', '../{name}', '{name}/../x', 'a/ .. /{name}', '..\\{name}'])('refuses %s, which climbs out of the folder', (template) =>
  {
    const result = render(template)
    expect(result.ok).toBe(false)
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([
      { code: 'template-escapes', severity: 'error', message: 'File names cannot climb out of the folder (..).' }
    ])
    expect(result.segments).not.toContain('..')
  })

  it.each(['/out/{name}', '\\out\\{name}', 'C:\\out\\{name}', 'd:/out/{name}', 'C:{name}', '\\\\nas\\share\\{name}'])('refuses %s, a full path', (template) =>
  {
    const result = render(template)
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toEqual({ code: 'template-escapes', severity: 'error', message: 'The file name cannot be a full path; choose the folder under Destination.' })
  })

  it.each(['', '{subdir}', '{name}/', '...', '{op}/ '])('refuses %s, which leaves the file name empty', (template) =>
  {
    const result = render(template, { subdir: '' })
    expect(result.ok).toBe(false)
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([
      { code: 'template-empty', severity: 'error', message: 'The file name is empty; add {name} or {catalog}.' }
    ])
  })

  it('refuses a name that sanitizes to nothing', () =>
  {
    expect(codes('{name}', { name: '. .' })).toEqual(['template-empty', 'template-sanitized'])
  })

  it('reports every refusal of one template', () =>
  {
    expect(codes('/{album}/../')).toEqual(['template-unknown-token', 'template-escapes', 'template-escapes', 'template-empty'])
    expect(codes('/{album}/..')).toEqual(['template-unknown-token', 'template-escapes', 'template-escapes'])
  })
})

describe('frame sequences', () =>
{
  it('doubles every % of the folder and keeps the sequence pattern', () =>
  {
    expect(frameSequencePattern('C:\\Out\\100% done', 'png', 'win32')).toBe('C:\\Out\\100%% done\\frame_%04d.png')
    expect(frameSequencePattern('/out/50%off/', 'jpg', 'linux')).toBe('/out/50%%off/frame_%04d.jpg')
    expect(frameSequencePattern('/out/%d%s', 'webp', 'darwin')).toBe('/out/%%d%%s/frame_%04d.webp')
    expect(frameSequencePattern('/out/plain', 'png', 'linux')).toBe('/out/plain/frame_%04d.png')
  })

  it('escapes a percent wherever it is', () =>
  {
    expect(escapePercent('%a%%b%')).toBe('%%a%%%%b%%')
    expect(escapePercent('none')).toBe('none')
  })

  it('names a frames folder by the rendered stem, percent and all', () =>
  {
    const folder = render('{name}', { name: '100% clip' }, 'win32')
    expect(folder.segments).toEqual(['100% clip'])
    expect(frameSequencePattern(`D:\\Frames\\${folder.relativePath}`, 'png', 'win32')).toBe('D:\\Frames\\100%% clip\\frame_%04d.png')
  })
})
