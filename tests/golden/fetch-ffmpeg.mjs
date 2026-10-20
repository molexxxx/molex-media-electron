/**
 * Downloads the pinned FFmpeg build for this platform into a temp folder, checks every asset's size and SHA-256
 * while it streams, extracts it under the same entry rules as the app's zip extractor, and prints the folder
 * holding ffmpeg and ffprobe once both answer -version. Everything but that folder goes to stderr, so
 * `MOLEX_FFMPEG_DIR=$(node tests/golden/fetch-ffmpeg.mjs)` works in a shell.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

const PIN_FILE = new URL('../../src/main/ffmpeg/pinned-builds.json', import.meta.url)
const SHA256 = /^[0-9a-f]{64}$/
const GONE = new Set([404, 410])
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
const MAX_ENTRIES = 20000
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const MADE_BY_UNIX = 3

function log(message)
{
  process.stderr.write(`[fetch-ffmpeg] ${message}\n`)
}

/** Checks one pinned asset the way the app's pin parser does. */
function readAsset(value, where)
{
  const a = value ?? {}
  const contains = Array.isArray(a.contains) ? a.contains : []
  const valid = typeof a.build === 'string' && /^[\w.-]+$/.test(a.build)
    && typeof a.url === 'string' && a.url.startsWith('https://')
    && Number.isSafeInteger(a.bytes) && a.bytes > 0
    && typeof a.sha256 === 'string' && SHA256.test(a.sha256)
    && (a.kind === 'zip' || a.kind === 'tar.xz')
    && contains.length > 0 && contains.every((c) => c === 'ffmpeg' || c === 'ffprobe')
  if (!valid) throw new Error(`Invalid pinned asset at ${where}`)
  return a
}

/** The primary and fallback assets of a platform key, or null when the pin has none. */
export function selectAssets(pin, platform, arch)
{
  const key = `${platform}-${arch}`
  const entry = pin.platforms?.[key]
  if (!entry) return null
  return {
    primary: (entry.primary ?? []).map((a, i) => readAsset(a, `${key}.primary[${i}]`)),
    fallback: (entry.fallback ?? []).map((a, i) => readAsset(a, `${key}.fallback[${i}]`))
  }
}

function executable(base)
{
  return process.platform === 'win32' ? `${base}.exe` : base
}

/** Streams one asset to disk, hashing as it arrives; stops as soon as the stream passes the pinned size. */
async function download(asset, target)
{
  const res = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body)
  {
    const err = new Error(`Download of ${asset.url} answered ${res.status}`)
    err.status = res.status
    throw err
  }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > 0 && declared !== asset.bytes)
  {
    throw new Error(`Download of ${asset.url} declares ${declared} bytes; the pin expects ${asset.bytes}`)
  }
  const hash = createHash('sha256')
  const out = createWriteStream(target)
  let bytes = 0
  let reported = 0
  try
  {
    for await (const chunk of res.body)
    {
      bytes += chunk.byteLength
      if (bytes > asset.bytes) throw new Error(`Download of ${asset.url} passed the pinned ${asset.bytes} bytes`)
      hash.update(chunk)
      if (!out.write(chunk)) await once(out, 'drain')
      if (bytes - reported >= asset.bytes / 10)
      {
        reported = bytes
        log(`${basename(target)}: ${Math.round((100 * bytes) / asset.bytes)} %`)
      }
    }
  }
  finally
  {
    out.end()
    await once(out, 'close')
  }
  const sha256 = hash.digest('hex')
  if (bytes !== asset.bytes || sha256 !== asset.sha256.toLowerCase())
  {
    rmSync(target, { force: true })
    throw new Error(`Download did not match the expected checksum: ${asset.url} gave ${bytes} bytes, sha256 ${sha256}`)
  }
  log(`${basename(target)}: ${bytes} bytes, sha256 verified`)
}

/** Resolves an archive entry name inside the root; refuses absolute names, drive letters, and `..` segments. */
export function safeJoin(root, name)
{
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`Refusing absolute archive entry: ${name}`)
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error(`Refusing archive entry with a traversal segment: ${name}`)
  const target = resolve(root, normalized)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing archive entry outside the destination: ${name}`)
  return target
}

function entryMode(entry)
{
  if (entry.versionMadeBy >> 8 !== MADE_BY_UNIX) return 0
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

/** Extracts a zip with yauzl: regular files and folders only, no links, every entry inside `dest`, sizes capped. */
export function extractZip(zipPath, dest)
{
  const root = resolve(dest)
  return new Promise((resolvePromise, reject) =>
  {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (openErr, zip) =>
    {
      if (openErr || !zip)
      {
        reject(openErr ?? new Error(`Could not open ${zipPath}`))
        return
      }
      let settled = false
      let entries = 0
      let total = 0
      const fail = (err) =>
      {
        if (settled) return
        settled = true
        zip.close()
        reject(err)
      }
      zip.on('error', fail)
      zip.on('end', () =>
      {
        if (settled) return
        settled = true
        resolvePromise()
      })
      zip.on('entry', (entry) =>
      {
        let target
        try
        {
          target = safeJoin(root, entry.fileName)
          entries++
          total += entry.uncompressedSize
          if (entries > MAX_ENTRIES) throw new Error(`Archive has more than ${MAX_ENTRIES} entries`)
          if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Archive entry is too large: ${entry.fileName}`)
          if (total > MAX_TOTAL_BYTES) throw new Error('Archive expands past the size cap')
          const type = entryMode(entry) & S_IFMT
          if (type === S_IFLNK) throw new Error(`Refusing link entry: ${entry.fileName}`)
          if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new Error(`Refusing non-regular entry: ${entry.fileName}`)
        }
        catch (err)
        {
          fail(err)
          return
        }
        if (entry.fileName.endsWith('/'))
        {
          mkdirSync(target, { recursive: true })
          zip.readEntry()
          return
        }
        mkdirSync(dirname(target), { recursive: true })
        zip.openReadStream(entry, (streamErr, stream) =>
        {
          if (streamErr || !stream)
          {
            fail(streamErr ?? new Error(`Could not read ${entry.fileName}`))
            return
          }
          const out = createWriteStream(target)
          stream.on('error', fail)
          out.on('error', fail)
          out.on('close', () =>
          {
            if (!settled) zip.readEntry()
          })
          stream.pipe(out)
        })
      })
      zip.readEntry()
    })
  })
}

function runTar(args, cwd)
{
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`tar ${args.join(' ')} exited with ${r.status}: ${(r.stderr ?? '').trim()}`)
  return r.stdout
}

/**
 * Lists, checks, and extracts a tar.xz in its own folder. tar runs with cwd at the archive's folder and only the
 * archive's name as an argument, so no drive letter reaches GNU tar.
 */
export function extractTarXz(archive)
{
  const cwd = dirname(archive)
  const name = basename(archive)
  let total = 0
  const listing = runTar(['-tvJf', name], cwd).split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (listing.length > MAX_ENTRIES) throw new Error(`Archive has more than ${MAX_ENTRIES} entries`)
  for (const line of listing)
  {
    const type = line[0]
    if ((type !== '-' && type !== 'd') || / link to | -> /.test(line)) throw new Error(`Refusing non-regular tar entry: ${line}`)
    const fields = line.trim().split(/\s+/)
    const size = Number(fields[1].includes('/') ? fields[2] : fields[4])
    if (Number.isFinite(size))
    {
      if (size > MAX_ENTRY_BYTES) throw new Error(`Tar entry is too large: ${line}`)
      total += size
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('Archive expands past the size cap')
  for (const entry of runTar(['-tJf', name], cwd).split(/\r?\n/).filter((line) => line.length > 0)) safeJoin(cwd, entry)
  runTar(['-xJf', name], cwd)
}

/** The folder under `root` that holds both ffmpeg and ffprobe, or null. */
export function findBinFolder(root)
{
  const stack = [root]
  while (stack.length > 0)
  {
    const dir = stack.pop()
    const names = readdirSync(dir, { withFileTypes: true })
    if (names.some((e) => e.isFile() && e.name === executable('ffmpeg')) && names.some((e) => e.isFile() && e.name === executable('ffprobe'))) return dir
    for (const e of names) if (e.isDirectory()) stack.push(join(dir, e.name))
  }
  return null
}

/** True when both binaries in `bin` exit 0 on -version and print their version line. */
function answersVersion(bin)
{
  return ['ffmpeg', 'ffprobe'].every((tool) =>
  {
    const r = spawnSync(join(bin, executable(tool)), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true })
    return r.status === 0 && (r.stdout ?? '').startsWith(`${tool} version `)
  })
}

async function install(assets, dest)
{
  const extractTo = join(dest, 'x')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(extractTo, { recursive: true })
  for (const asset of assets)
  {
    const archive = join(extractTo, basename(new URL(asset.url).pathname))
    log(`Downloading ${asset.url}`)
    await download(asset, archive)
    if (asset.kind === 'zip') await extractZip(archive, extractTo)
    else extractTarXz(archive)
    rmSync(archive, { force: true })
  }
  const bin = findBinFolder(extractTo)
  if (!bin) throw new Error('The extracted build has no folder holding both ffmpeg and ffprobe')
  if (process.platform !== 'win32')
  {
    for (const tool of ['ffmpeg', 'ffprobe']) chmodSync(join(bin, tool), 0o755)
  }
  return bin
}

/** Fetches or reuses the pinned build and returns its bin folder. */
export async function fetchPinned(env = process.env)
{
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'))
  const sets = selectAssets(pin, process.platform, process.arch)
  if (!sets || (sets.primary.length === 0 && sets.fallback.length === 0)) throw new Error(`The pin has no build for ${process.platform}-${process.arch}`)
  const root = resolve(env.MOLEX_GOLDEN_OUT?.trim() || join(tmpdir(), 'molex-golden'), 'ffmpeg')
  for (const assets of [sets.primary, sets.fallback])
  {
    if (assets.length === 0) continue
    const dest = join(root, assets[0].build)
    const marker = join(dest, 'verified.json')
    const digests = assets.map((a) => a.sha256)
    if (existsSync(marker))
    {
      const seen = JSON.parse(readFileSync(marker, 'utf8'))
      if (JSON.stringify(seen.sha256) === JSON.stringify(digests) && seen.bin && existsSync(seen.bin) && answersVersion(seen.bin))
      {
        log(`Reusing ${seen.bin}`)
        return seen.bin
      }
    }
    try
    {
      const bin = await install(assets, dest)
      if (!answersVersion(bin)) throw new Error(`ffmpeg or ffprobe in ${bin} did not answer -version`)
      writeFileSync(marker, JSON.stringify({ pin: pin.id, sha256: digests, bin }, null, 2))
      return bin
    }
    catch (err)
    {
      if (assets === sets.primary && GONE.has(err?.status) && sets.fallback.length > 0)
      {
        log(`${err.message}; trying the fallback build`)
        continue
      }
      throw err
    }
  }
  throw new Error('No pinned build could be fetched')
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase())
{
  fetchPinned().then((bin) =>
  {
    process.stdout.write(`${bin}\n`)
  }, (err) =>
  {
    log(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
