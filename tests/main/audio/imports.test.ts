/**
 * The audio module runs in plain Node: nothing under src/main/ffmpeg/audio/, src/main/ffmpeg/exec.ts,
 * src/main/ffmpeg/build.ts, or src/shared/audio/ may load config, logger, electron, or fs, directly or through a
 * relative import, because config constructs electron-store and electron cannot load outside the app.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SCANNED_FOLDERS = ['src/main/ffmpeg/audio', 'src/shared/audio']
const SCANNED_FILES = ['src/main/ffmpeg/exec.ts', 'src/main/ffmpeg/build.ts']

const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const ELECTRON = /^(?:electron(?:[-/].*)?|@electron-toolkit\/.*)$/
const FILE_SYSTEM = /^(?:(?:node:)?fs(?:\/promises)?|fs-extra|graceful-fs|original-fs)$/
const APP_MODULE = /(?:^|\/)(?:config|logger)(?:\.[cm]?[jt]s)?$/

/** The module specifiers a TypeScript source imports, re-exports, or loads dynamically, comments left out. */
function importSpecifiers(source: string): string[]
{
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const found = [...code.matchAll(STATIC_IMPORT), ...code.matchAll(DYNAMIC_IMPORT)].map((match) => match[1])
  return [...new Set(found)]
}

/** Why a specifier is forbidden, or null when it is allowed. */
function forbiddenReason(specifier: string): string | null
{
  if (ELECTRON.test(specifier))
  {
    return 'electron'
  }
  if (FILE_SYSTEM.test(specifier))
  {
    return 'fs'
  }
  if (specifier.startsWith('.') && APP_MODULE.test(specifier))
  {
    return specifier.replace(/\.[cm]?[jt]s$/, '').split('/').pop() as string
  }
  return null
}

function resolveRelative(from: string, specifier: string): string | null
{
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  return found !== undefined && /\.tsx?$/.test(found) ? found : null
}

function scannedRoots(): string[]
{
  const folders = SCANNED_FOLDERS.flatMap((folder) =>
    fs.readdirSync(path.join(ROOT, folder), { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(ROOT, folder, name)))
  const files = SCANNED_FILES.map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file))
  return [...folders, ...files]
}

interface SourceHost
{
  read: (file: string) => string
  resolve: (from: string, specifier: string) => string | null
}

const DISK: SourceHost = { read: (file) => fs.readFileSync(file, 'utf8'), resolve: resolveRelative }

function shown(file: string): string
{
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

/** Every forbidden import reachable from the roots through relative imports, as "chain imports 'specifier' (reason)". */
function violations(roots: readonly string[], host: SourceHost = DISK): string[]
{
  const found: string[] = []
  const seen = new Set<string>()
  const queue: Array<{ file: string; chain: string[] }> = roots.map((file) => ({ file, chain: [shown(file)] }))
  while (queue.length > 0)
  {
    const { file, chain } = queue.shift() as { file: string; chain: string[] }
    if (seen.has(file))
    {
      continue
    }
    seen.add(file)
    for (const specifier of importSpecifiers(host.read(file)))
    {
      const reason = forbiddenReason(specifier)
      if (reason !== null)
      {
        found.push(`${chain.join(' -> ')} imports '${specifier}' (${reason})`)
        continue
      }
      const next = specifier.startsWith('.') ? host.resolve(file, specifier) : null
      if (next !== null)
      {
        queue.push({ file: next, chain: [...chain, shown(next)] })
      }
    }
  }
  return found
}

describe('importSpecifiers', () =>
{
  it('finds static, type-only, side-effect, re-export, dynamic, and require imports across lines', () =>
  {
    const source = [
      "import { a } from './a'",
      "import type {",
      '  B,',
      '  C',
      "} from '../b'",
      "import './side-effect'",
      "export * from './c'",
      "export type { D } from './d'",
      "const e = await import('./e')",
      "const f = require('f')",
      "export const label = 'not a module'"
    ].join('\n')
    expect(importSpecifiers(source)).toEqual(['./a', '../b', './side-effect', './c', './d', './e', 'f'])
  })

  it('leaves out imports inside comments', () =>
  {
    const source = "/**\n * import { app } from 'electron'\n */\n// import fs from 'fs'\nimport path from 'node:path'"
    expect(importSpecifiers(source)).toEqual(['node:path'])
  })
})

describe('forbiddenReason', () =>
{
  it.each([
    ['../../config', 'config'],
    ['../config.ts', 'config'],
    ['../../logger', 'logger'],
    ['./logger.js', 'logger'],
    ['electron', 'electron'],
    ['electron/main', 'electron'],
    ['electron-store', 'electron'],
    ['@electron-toolkit/utils', 'electron'],
    ['fs', 'fs'],
    ['node:fs', 'fs'],
    ['fs/promises', 'fs'],
    ['node:fs/promises', 'fs'],
    ['fs-extra', 'fs'],
    ['original-fs', 'fs']
  ])('forbids %s', (specifier, reason) =>
  {
    expect(forbiddenReason(specifier)).toBe(reason)
  })

  it.each(['child_process', 'node:path', 'string_decoder', './configs', './plan', '../timers', '../../../shared/audio/types', 'fs-like'])(
    'allows %s', (specifier) =>
    {
      expect(forbiddenReason(specifier)).toBeNull()
    })
})

describe('violations', () =>
{
  const virtual = (name: string): string => path.join(ROOT, 'virtual', name)
  const files: Record<string, string> =
  {
    [virtual('clean.ts')]: "import { spawn } from 'child_process'\nimport { x } from './missing'",
    [virtual('dirty.ts')]: "import type { AppConfig } from '../src/main/config'\nconst fs = require('node:fs')",
    [virtual('root.ts')]: "import { probe } from './middle'\nimport { again } from './middle'",
    [virtual('middle.ts')]: "import { log } from './root'\nexport * from '../src/main/logger'"
  }
  const host = {
    read: (file: string): string => files[file],
    resolve: (from: string, specifier: string): string | null =>
    {
      const target = `${path.resolve(path.dirname(from), specifier)}.ts`
      return target in files ? target : null
    }
  }

  it('fails on a forbidden import, type-only imports included', () =>
  {
    expect(violations([virtual('dirty.ts')], host)).toEqual([
      "virtual/dirty.ts imports '../src/main/config' (config)",
      "virtual/dirty.ts imports 'node:fs' (fs)"
    ])
  })

  it('follows relative imports to the module that loads a forbidden one, once per module', () =>
  {
    expect(violations([virtual('root.ts')], host)).toEqual(["virtual/root.ts -> virtual/middle.ts imports '../src/main/logger' (logger)"])
  })

  it('passes a clean module whose relative import does not resolve', () =>
  {
    expect(violations([virtual('clean.ts')], host)).toEqual([])
  })

  it('resolves relative imports on disk to TypeScript files only', () =>
  {
    const from = path.join(ROOT, 'src', 'main', 'ffmpeg', 'audio', 'verify.ts')
    expect(resolveRelative(from, './measure')).toBe(path.join(ROOT, 'src', 'main', 'ffmpeg', 'audio', 'measure.ts'))
    expect(resolveRelative(from, './missing')).toBeNull()
    expect(resolveRelative(path.join(ROOT, 'package.json'), './package.json')).toBeNull()
  })
})

describe('the audio module import rule', () =>
{
  it('scans every module of the audio folders, exec.ts, and build.ts once it exists', () =>
  {
    const roots = scannedRoots().map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
    expect(roots).toEqual(expect.arrayContaining([
      'src/main/ffmpeg/audio/measure.ts',
      'src/main/ffmpeg/audio/verify.ts',
      'src/main/ffmpeg/audio/types.ts',
      'src/main/ffmpeg/exec.ts',
      'src/shared/audio/types.ts'
    ]))
    expect(roots.includes('src/main/ffmpeg/build.ts')).toBe(fs.existsSync(path.join(ROOT, 'src/main/ffmpeg/build.ts')))
  })

  it('finds no config, logger, electron, or fs import', () =>
  {
    expect(violations(scannedRoots())).toEqual([])
  })
})

describe('the audio types module', () =>
{
  it('re-exports types only, so importing it loads nothing at runtime', async () =>
  {
    const types = await import('../../../src/main/ffmpeg/audio/types')
    expect(Object.keys(types)).toEqual([])
  })

  it('re-exports the shared wire types and the main-only specs', () =>
  {
    const source = fs.readFileSync(path.join(ROOT, 'src/main/ffmpeg/audio/types.ts'), 'utf8')
    expect(source).toMatch(/^export type \* from '\.\.\/\.\.\/\.\.\/shared\/audio\/types'$/m)
    for (const name of ['ChainSpec', 'MeasureSpec', 'VerifySpec', 'VerifyParse', 'BuildCapabilities', 'ContainerSpec', 'Exec', 'ExecResult'])
    {
      expect(source).toMatch(new RegExp(`^export type \\{[^}]*\\b${name}\\b[^}]*\\} from `, 'm'))
    }
    expect(source).not.toMatch(/^export (?!type\b)/m)
  })
})
