/**
 * Import boundary of src/shared. Both the main process and the renderer load these modules, so a module there
 * imports only from inside the folder, never electron or a Node builtin, and never reads window, document, or
 * navigator. The web compiler rejects Node globals but accepts all of these, so this scan enforces them.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const SHARED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/shared')

type Rule = 'outside' | 'electron' | 'builtin' | 'dom'

interface Violation
{
  file: string
  line: number
  rule: Rule
  detail: string
}

interface Scanned
{
  /** The source with comments blanked; string literals kept. */
  noComments: string
  /** The source with comments, string literals, and template text blanked; template expressions kept. */
  code: string
}

function blank(text: string): string
{
  return text.replace(/[^\n]/g, ' ')
}

/** Splits a source into views that keep every character's position, so a match in one view is a match in the source. */
function scan(source: string): Scanned
{
  let noComments = ''
  let code = ''
  const templateDepths: number[] = []
  let depth = 0
  let i = 0
  const keep = (from: number, to: number, inCode: boolean): void =>
  {
    const text = source.slice(from, to)
    noComments += text
    code += inCode ? text : blank(text)
  }
  const drop = (from: number, to: number): void =>
  {
    const text = blank(source.slice(from, to))
    noComments += text
    code += text
  }
  const templateText = (from: number): number =>
  {
    let j = from
    while (j < source.length)
    {
      if (source[j] === '\\')
      {
        j += 2
        continue
      }
      if (source[j] === '`')
      {
        return j + 1
      }
      if (source[j] === '$' && source[j + 1] === '{')
      {
        templateDepths.push(depth)
        return j + 2
      }
      j += 1
    }
    return source.length
  }
  while (i < source.length)
  {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/')
    {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      drop(i, stop)
      i = stop
    }
    else if (c === '/' && next === '*')
    {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      drop(i, stop)
      i = stop
    }
    else if (c === '\'' || c === '"')
    {
      let j = i + 1
      while (j < source.length && source[j] !== c && source[j] !== '\n')
      {
        j += source[j] === '\\' ? 2 : 1
      }
      const stop = Math.min(j + 1, source.length)
      keep(i, stop, false)
      i = stop
    }
    else if (c === '`' || (c === '}' && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth))
    {
      if (c === '}')
      {
        templateDepths.pop()
      }
      const stop = templateText(i + 1)
      keep(i, stop, false)
      i = stop
    }
    else
    {
      if (c === '{')
      {
        depth += 1
      }
      else if (c === '}')
      {
        depth -= 1
      }
      keep(i, i + 1, true)
      i += 1
    }
  }
  return { noComments, code }
}

const IMPORT_PATTERNS =
[
  /\b(?:import|export)(?:\s+type)?\s+[\w\s{},*$]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
]

function lineOf(source: string, index: number): number
{
  return source.slice(0, index).split('\n').length
}

function isBuiltin(specifier: string): boolean
{
  return specifier.startsWith('node:') || builtinModules.includes(specifier) || builtinModules.includes(specifier.split('/')[0])
}

function importViolation(file: string, specifier: string): { rule: Rule; detail: string } | null
{
  if (specifier === 'electron' || specifier.startsWith('electron/'))
  {
    return { rule: 'electron', detail: `imports ${specifier}` }
  }
  if (isBuiltin(specifier))
  {
    return { rule: 'builtin', detail: `imports the Node builtin ${specifier}` }
  }
  if (!specifier.startsWith('.'))
  {
    return { rule: 'outside', detail: `imports the package ${specifier}` }
  }
  const resolved = path.resolve(path.dirname(file), specifier)
  if (resolved !== SHARED_ROOT && !resolved.startsWith(SHARED_ROOT + path.sep))
  {
    return { rule: 'outside', detail: `imports ${specifier}, outside src/shared` }
  }
  return null
}

const DOM_GLOBAL = /\b(window|document|navigator)\b/g

function readsDomGlobal(code: string, index: number, name: string): boolean
{
  const before = code.slice(0, index).trimEnd()
  if (before.endsWith('.') && !before.endsWith('...'))
  {
    return /\b(?:globalThis|self)\??\.$/.test(before)
  }
  const after = code.slice(index + name.length)
  const lineStart = code.lastIndexOf('\n', index - 1) + 1
  const atLineStart = code.slice(lineStart, index).trim() === ''
  const declares = /^[ \t]*\??[ \t]*:/.test(after) && (atLineStart || /[{,;(]$/.test(before))
  return !declares
}

/** Every boundary violation in one source file. */
function findViolations(file: string, source: string): Violation[]
{
  const { noComments, code } = scan(source)
  const violations: Violation[] = []
  for (const pattern of IMPORT_PATTERNS)
  {
    for (const match of noComments.matchAll(pattern))
    {
      const index = match.index ?? 0
      if (code[index] === ' ')
      {
        continue
      }
      const found = importViolation(file, match[2])
      if (found)
      {
        violations.push({ file, line: lineOf(source, index), ...found })
      }
    }
  }
  for (const match of code.matchAll(DOM_GLOBAL))
  {
    const index = match.index ?? 0
    if (readsDomGlobal(code, index, match[1]))
    {
      violations.push({ file, line: lineOf(source, index), rule: 'dom', detail: `reads ${match[1]}` })
    }
  }
  return violations
}

function sharedFiles(dir: string = SHARED_ROOT): string[]
{
  if (!fs.existsSync(dir))
  {
    return []
  }
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
  {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
    {
      files.push(...sharedFiles(full))
    }
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name))
    {
      files.push(full)
    }
  }
  return files
}

function treeViolations(rule: Rule): string[]
{
  return sharedFiles()
    .flatMap((file) => findViolations(file, fs.readFileSync(file, 'utf8')))
    .filter((violation) => violation.rule === rule)
    .map((violation) => `${path.relative(SHARED_ROOT, violation.file)}:${violation.line} ${violation.detail}`)
}

const FIXTURE = path.join(SHARED_ROOT, 'jobs', 'fixture.ts')

function rulesOf(source: string): Rule[]
{
  return findViolations(FIXTURE, source).map((violation) => violation.rule)
}

describe('src/shared import boundary', () =>
{
  it('finds the shared modules to scan', () =>
  {
    expect(sharedFiles().length).toBeGreaterThan(0)
  })

  it('imports only from inside src/shared', () =>
  {
    expect(treeViolations('outside')).toEqual([])
  })

  it('never imports electron', () =>
  {
    expect(treeViolations('electron')).toEqual([])
  })

  it('never imports a Node builtin', () =>
  {
    expect(treeViolations('builtin')).toEqual([])
  })

  it('never reads window, document, or navigator', () =>
  {
    expect(treeViolations('dom')).toEqual([])
  })
})

describe('boundary scanner', () =>
{
  it('accepts relative imports that stay inside src/shared', () =>
  {
    const source = [
      'import type { NormalizeRecipe } from \'../audio/types\'',
      'import { renderMessage } from \'../audio/messages\'',
      'export * from \'./ids\'',
      'export { formatCatalog } from \'./ids\''
    ].join('\n')
    expect(rulesOf(source)).toEqual([])
  })

  it('flags electron in static, type-only, dynamic, and require forms', () =>
  {
    expect(rulesOf('import { app } from \'electron\'')).toEqual(['electron'])
    expect(rulesOf('import type { WebContents } from "electron"')).toEqual(['electron'])
    expect(rulesOf('const e = await import(\'electron\')')).toEqual(['electron'])
    expect(rulesOf('const e = require(\'electron/main\')')).toEqual(['electron'])
  })

  it('flags Node builtins with and without the node: prefix', () =>
  {
    expect(rulesOf('import fs from \'node:fs\'')).toEqual(['builtin'])
    expect(rulesOf('import path from \'path\'')).toEqual(['builtin'])
    expect(rulesOf('import { readFile } from \'fs/promises\'')).toEqual(['builtin'])
    expect(rulesOf('import \'node:process\'')).toEqual(['builtin'])
  })

  it('flags packages and relative paths that leave src/shared', () =>
  {
    expect(rulesOf('import { create } from \'zustand\'')).toEqual(['outside'])
    expect(rulesOf('import { getConfig } from \'../../main/config\'')).toEqual(['outside'])
    expect(rulesOf('import type { AppConfig } from \'../../renderer/src/stores/types\'')).toEqual(['outside'])
    expect(rulesOf('export { logger } from \'../../main/logger\'')).toEqual(['outside'])
  })

  it('reads imports across lines', () =>
  {
    expect(rulesOf('import\n{\n  app,\n  shell\n} from \'electron\'')).toEqual(['electron'])
  })

  it('flags DOM globals read directly, through spread, or through globalThis and self', () =>
  {
    expect(rulesOf('export const width = window.innerWidth')).toEqual(['dom'])
    expect(rulesOf('const title = document.title')).toEqual(['dom'])
    expect(rulesOf('const lang = navigator.language')).toEqual(['dom'])
    expect(rulesOf('const w = globalThis.window')).toEqual(['dom'])
    expect(rulesOf('const d = self.document')).toEqual(['dom'])
    expect(rulesOf('const w = flag ? window : null')).toEqual(['dom'])
    expect(rulesOf('const w = `${window.innerWidth}px`')).toEqual(['dom'])
    expect(rulesOf('export const langs = [...navigator.languages]')).toEqual(['dom'])
    expect(rulesOf('export const w = { ...window }')).toEqual(['dom'])
    expect(rulesOf('const args = pick(... document, { ...window, a: 1 })')).toEqual(['dom', 'dom'])
    expect(rulesOf('const list = [...items.window]')).toEqual([])
  })

  it('ignores comments, strings, template text, property access, and member names', () =>
  {
    const source = [
      '// import { app } from \'electron\', reading window',
      '/* import fs from \'node:fs\'; document.title */',
      'const words = \'window, document, navigator\'',
      'const url = \'https://example.com/document\'',
      'const text = `the window ${count} document`',
      'const pick = options.window + layout.document',
      'interface Popup',
      '{',
      '  window: number',
      '  document?: string',
      '}',
      'const value = { navigator: 1, window: 2 }',
      'const label = r.number(\'from\', \'khz\')',
      'const said = \'export x from "electron"\''
    ].join('\n')
    expect(findViolations(FIXTURE, source)).toEqual([])
  })

  it('reports the line of each violation', () =>
  {
    const found = findViolations(FIXTURE, 'const a = 1\n\nimport { app } from \'electron\'')
    expect(found).toEqual([{ file: FIXTURE, line: 3, rule: 'electron', detail: 'imports electron' }])
  })

  it('treats an unterminated comment, string, or template as running to the end', () =>
  {
    expect(rulesOf('/* import fs from \'node:fs\'')).toEqual([])
    expect(rulesOf('const s = \'unterminated\nconst w = window.x')).toEqual(['dom'])
    expect(rulesOf('const t = `open ${a} window')).toEqual([])
    expect(rulesOf('const t = `\\` window`')).toEqual([])
  })

  it('returns no files for a folder that does not exist', () =>
  {
    expect(sharedFiles(path.join(SHARED_ROOT, 'missing'))).toEqual([])
  })
})
