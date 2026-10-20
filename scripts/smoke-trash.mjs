/**
 * Checks the platform facts the job engine relies on, under the repo's Electron:
 *
 * - shell.trashItem moves a local file to the Recycle Bin (the item is then restored and deleted);
 * - on a network share it rejects at once and the file stays; the engine never calls the trash there, because the
 *   volume reports no bin, and the script says what the engine would do with the rejection if it did;
 * - a file another process opened without sharing makes rename and unlink fail with EBUSY until it closes, and
 *   shell.trashItem on it must reject with something other than "Operation was aborted", which the engine reads as
 *   a volume without a bin and never retries;
 * - the engine's DriveInfo query reports a mapped network drive and a UNC path as network, with no Recycle Bin.
 *
 * Usage: npx electron scripts/smoke-trash.mjs <a temp folder> [<a network share folder>]
 *
 * Everything it writes lives in a `molex-smoke-<token>` folder it creates inside each folder it is given, and it
 * removes those folders before it exits. A leg that cannot run (no share given or reachable, no mapped drive, not
 * Windows) is reported as skipped. Exit code 0 when nothing failed, 1 when a check failed, 2 for a usage error.
 * The script is a development check and is not packaged.
 */

import electron from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (typeof electron === 'string' || !electron.app)
{
  console.error('Run this under Electron, not Node: npx electron scripts/smoke-trash.mjs <a temp folder> [<a network share folder>] (unset ELECTRON_RUN_AS_NODE first).')
  process.exit(2)
}

const { app, shell } = electron
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const WATCHDOG_MS = 180_000
const SHARE_REACH_MS = 5_000
const ABORTED_TRASH = /operation was aborted/i

/** The arguments after this script's path. */
function scriptArgs()
{
  const at = process.argv.findIndex((arg) => /smoke-trash\.mjs$/i.test(arg))
  return at < 0 ? [] : process.argv.slice(at + 1).filter((arg) => !arg.startsWith('--'))
}

const [tempArg, shareArg] = scriptArgs()
const token = randomBytes(6).toString('hex')
const results = []

function usage(message)
{
  console.error(message)
  console.error('Usage: npx electron scripts/smoke-trash.mjs <a temp folder> [<a network share folder>]')
  app.exit(2)
}

/** Records one check. */
function record(leg, status, detail)
{
  results.push({ leg, status, detail })
  console.log(`[${status}] ${leg}: ${detail}`)
}

function messageOf(err)
{
  return err instanceof Error ? err.message : String(err)
}

function codeOf(err)
{
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : null
}

async function exists(file)
{
  try
  {
    await fs.lstat(file)
    return true
  }
  catch
  {
    return false
  }
}

function withTimeout(promise, ms, what)
{
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) =>
    {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
    })
  ])
}

function sleep(ms)
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Windows PowerShell by its full path, so a program on the PATH cannot stand in for it. */
function powershell()
{
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function encoded(script)
{
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** Runs a PowerShell script with extra environment values and returns its stdout. */
function runPowerShell(script, env, timeoutMs = 30_000)
{
  return new Promise((resolve, reject) =>
  {
    const child = spawn(powershell(), encoded(script), { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() =>
    {
      child.kill()
      reject(new Error(`PowerShell took longer than ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) =>
    {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) =>
    {
      clearTimeout(timer)
      if (code === 0)
      {
        resolve(stdout)
      }
      else
      {
        reject(new Error(`PowerShell exited ${code}: ${stderr.trim().slice(0, 400)}`))
      }
    })
  })
}

/** Finds the bin item whose name carries a token, and optionally restores it to where it was deleted from. */
const BIN_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$shell = New-Object -ComObject Shell.Application',
  '$bin = $shell.NameSpace(10)',
  '$found = @($bin.Items() | Where-Object { $_.Name -like ("*" + $env:MOLEX_SMOKE_TOKEN + "*") })',
  '$result = [ordered]@{ found = $found.Count; from = $null; restored = $false }',
  'if ($found.Count -eq 1)',
  '{',
  '  $result.from = [string]$found[0].ExtendedProperty("System.Recycle.DeletedFrom")',
  '  if ($env:MOLEX_SMOKE_RESTORE -eq "1")',
  '  {',
  '    $found[0].InvokeVerb("undelete")',
  '    $result.restored = $true',
  '  }',
  '}',
  'ConvertTo-Json -InputObject ([pscustomobject]$result) -Compress'
].join('\n')

/** Opens a file with FileShare.None, prints "open", and closes it when a line arrives on stdin. */
const LOCK_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$f = [System.IO.File]::Open($env:MOLEX_SMOKE_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
  '[Console]::Out.WriteLine("open")',
  '[Console]::Out.Flush()',
  '[void][Console]::In.ReadLine()',
  '$f.Close()',
  '[Console]::Out.WriteLine("closed")',
  '[Console]::Out.Flush()'
].join('\n')

/** Holds a file open without sharing until `release` is called. */
function holdLocked(file)
{
  return new Promise((resolve, reject) =>
  {
    const child = spawn(powershell(), encoded(LOCK_SCRIPT), { env: { ...process.env, MOLEX_SMOKE_FILE: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let opened = false
    const closed = new Promise((done) => child.on('close', (code) => done(code)))
    const timer = setTimeout(() =>
    {
      child.kill()
      reject(new Error('The lock holder did not open the file in 20 s'))
    }, 20_000)
    child.stdout.on('data', (chunk) =>
    {
      stdout += chunk
      if (!opened && stdout.includes('open'))
      {
        opened = true
        clearTimeout(timer)
        resolve({
          async release()
          {
            child.stdin.end('\n')
            const code = await withTimeout(closed, 10_000, 'Closing the locked file')
            if (code !== 0 || !stdout.includes('closed'))
            {
              throw new Error(`The lock holder exited ${code}: ${stderr.trim().slice(0, 300)}`)
            }
          }
        })
      }
    })
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) =>
    {
      clearTimeout(timer)
      reject(err)
    })
    void closed.then((code) =>
    {
      if (!opened)
      {
        clearTimeout(timer)
        reject(new Error(`The lock holder exited ${code} before opening the file: ${stderr.trim().slice(0, 300)}`))
      }
    })
  })
}

/** The engine's volume module, loaded from source through Node's type stripping. */
async function loadVolumes()
{
  return import(pathToFileURL(path.join(REPO, 'src', 'main', 'jobs', 'volumes.ts')).href)
}

/** Runs the engine's own DriveInfo query and parses it with the engine's parser. */
async function volumeQuery(volumes)
{
  const stdout = await runPowerShell(volumes.WINDOWS_VOLUME_SCRIPT, {}, 30_000)
  const query = volumes.parseWindowsVolumeQuery(stdout)
  if (query === null)
  {
    throw new Error(`The DriveInfo query printed no usable JSON: ${stdout.slice(0, 200)}`)
  }
  return query
}

/** Creates the folder the script works in, inside a folder it was given. */
async function workFolder(parent)
{
  const folder = path.join(parent, `molex-smoke-${token}`)
  await fs.mkdir(folder)
  return folder
}

async function localTrash(folder, info)
{
  const leg = 'local trash'
  if (info !== null && info.trash !== 'available')
  {
    record(leg, 'skipped', `the temp folder's volume reports trash '${info.trash}', so it has no Recycle Bin to test`)
    return
  }
  const name = `molex-smoke-trash-${token}.txt`
  const file = path.join(folder, name)
  await fs.writeFile(file, `molexMedia trash smoke ${token}\n`)
  try
  {
    await withTimeout(shell.trashItem(path.normalize(file)), 30_000, 'shell.trashItem')
  }
  catch (err)
  {
    record(leg, 'failed', `shell.trashItem rejected for a local file: ${messageOf(err)}`)
    await fs.rm(file, { force: true })
    return
  }
  if (await exists(file))
  {
    record(leg, 'failed', 'shell.trashItem resolved but the file is still in place')
    await fs.rm(file, { force: true })
    return
  }
  if (!IS_WINDOWS)
  {
    record(leg, 'passed', 'shell.trashItem moved the file out of the folder (the bin itself is checked on Windows only)')
    return
  }
  const found = JSON.parse(await runPowerShell(BIN_SCRIPT, { MOLEX_SMOKE_TOKEN: token, MOLEX_SMOKE_RESTORE: '1' }))
  if (found.found !== 1)
  {
    record(leg, 'failed', `the file left its folder but ${found.found} Recycle Bin items carry its name`)
    return
  }
  const from = String(found.from ?? '')
  if (path.resolve(from).toLowerCase() !== path.resolve(folder).toLowerCase())
  {
    record(leg, 'failed', `the Recycle Bin item was deleted from ${from}, not ${folder}`)
    return
  }
  const end = Date.now() + 10_000
  while (!(await exists(file)) && Date.now() < end)
  {
    await sleep(100)
  }
  if (await exists(file))
  {
    await fs.rm(file, { force: true })
    record(leg, 'passed', 'shell.trashItem moved the file into the Recycle Bin (found by name and original folder, then restored and deleted)')
  }
  else
  {
    record(leg, 'passed', `shell.trashItem moved the file into the Recycle Bin; restoring it did not finish, so ${name} is still in the bin and can be deleted there`)
  }
}

async function reachable(folder)
{
  try
  {
    const stats = await withTimeout(fs.stat(folder), SHARE_REACH_MS, `Reaching ${folder}`)
    return stats.isDirectory() ? null : `${folder} is not a folder`
  }
  catch (err)
  {
    return messageOf(err)
  }
}

/**
 * shell.trashItem on the share rejects at once and keeps the file. The engine never calls the trash for a volume the
 * DriveInfo query reports without a bin; the classification leg says what it would do if it did.
 */
async function shareTrash(share, info)
{
  const leg = 'share trash'
  const classLeg = 'share trash classification'
  if (!share)
  {
    record(leg, 'skipped', 'no network share folder was given')
    record(classLeg, 'skipped', 'no network share folder was given')
    return
  }
  const unreachable = await reachable(share)
  if (unreachable !== null)
  {
    record(leg, 'skipped', `the share is not reachable: ${unreachable}`)
    record(classLeg, 'skipped', 'the share is not reachable')
    return
  }
  const folder = await workFolder(share)
  try
  {
    const file = path.join(folder, `molex-smoke-share-${token}.txt`)
    const body = `molexMedia share smoke ${token}\n`
    await fs.writeFile(file, body)
    const started = Date.now()
    let rejection = null
    try
    {
      await withTimeout(shell.trashItem(path.normalize(file)), 30_000, 'shell.trashItem on the share')
    }
    catch (err)
    {
      rejection = err
    }
    const elapsed = Date.now() - started
    const kept = (await exists(file)) && (await fs.readFile(file, 'utf8')) === body
    if (rejection === null)
    {
      record(leg, 'failed', `shell.trashItem resolved on the share in ${elapsed} ms; the file is ${kept ? 'still there' : 'gone, deleted for good'}`)
    }
    else if (!kept)
    {
      record(leg, 'failed', `shell.trashItem rejected with "${messageOf(rejection)}", but the file is gone`)
    }
    else if (elapsed > SHARE_REACH_MS)
    {
      record(leg, 'failed', `shell.trashItem took ${elapsed} ms to reject ("${messageOf(rejection)}")`)
    }
    else
    {
      record(leg, 'passed', `shell.trashItem rejected in ${elapsed} ms with "${messageOf(rejection)}" and the file stayed`)
    }
    if (rejection !== null)
    {
      const aborted = ABORTED_TRASH.test(messageOf(rejection))
      const guarded = info !== null && info.trash === 'unavailable'
      const would = aborted ? 'keep the file and mark the volume at once' : 'retry it on the lock schedule for 30 s before keeping the file'
      record(classLeg, guarded || aborted ? 'passed' : 'failed', guarded
        ? `the volume reports trash 'unavailable', so the engine keeps displaced files there without calling the trash; were it called, it would ${would}`
        : `the volume reports trash '${info?.trash ?? 'unknown'}', so the engine calls the trash here and would ${would}`)
    }
  }
  finally
  {
    await fs.rm(folder, { recursive: true, force: true })
  }
}

async function expectBusy(what, op)
{
  try
  {
    await op()
    return `${what} succeeded while the file was open without sharing`
  }
  catch (err)
  {
    return codeOf(err) === 'EBUSY' ? null : `${what} failed with ${codeOf(err) ?? messageOf(err)}, not EBUSY`
  }
}

/**
 * Two legs over one file held open without sharing: rename and unlink fail with EBUSY until it closes, and
 * shell.trashItem rejects in a way the engine's trash wrapper retries: anything but "Operation was aborted", or that
 * message while a write probe reports the file busy, which the engine reads as a lock rather than a volume without a bin.
 */
async function locks(folder)
{
  const busyLeg = 'sharing violation'
  const trashLeg = 'locked trash'
  if (!IS_WINDOWS)
  {
    record(busyLeg, 'skipped', 'sharing modes are a Windows behavior')
    record(trashLeg, 'skipped', 'sharing modes are a Windows behavior')
    return
  }
  const file = path.join(folder, `molex-smoke-lock-${token}.bin`)
  const moved = `${file}.moved`
  await fs.writeFile(file, randomBytes(1024))
  const lock = await holdLocked(file)
  const busy = []
  let trash = { status: 'passed', detail: '' }
  try
  {
    for (const problem of [
      await expectBusy('rename', () => fs.rename(file, moved)),
      await expectBusy('unlink', () => fs.unlink(file))
    ])
    {
      if (problem !== null)
      {
        busy.push(problem)
      }
    }
    try
    {
      await withTimeout(shell.trashItem(path.normalize(file)), 30_000, 'shell.trashItem on a locked file')
      trash = { status: 'failed', detail: 'shell.trashItem resolved while the file was open without sharing' }
    }
    catch (err)
    {
      if (!ABORTED_TRASH.test(messageOf(err)))
      {
        trash = { status: 'passed', detail: `shell.trashItem rejected with "${messageOf(err)}", which the engine retries on the lock schedule` }
      }
      else
      {
        const probe = await expectBusy('open for writing', async () => (await fs.open(file, 'r+')).close())
        trash = probe === null
          ? { status: 'passed', detail: `shell.trashItem rejected with "${messageOf(err)}", and opening the file for writing failed with a lock code, so the engine reads it as a file open elsewhere and retries on the lock schedule without marking the volume` }
          : { status: 'failed', detail: `shell.trashItem rejected with "${messageOf(err)}", but the write probe the engine uses to tell a busy file from a volume without a bin did not report a lock: ${probe}` }
      }
    }
    if (!(await exists(file)))
    {
      busy.push('the locked file disappeared')
    }
  }
  finally
  {
    await lock.release()
  }
  try
  {
    await fs.rename(file, moved)
    await fs.unlink(moved)
  }
  catch (err)
  {
    busy.push(`after the file closed, rename and unlink failed: ${codeOf(err) ?? messageOf(err)}`)
  }
  if (busy.length > 0)
  {
    record(busyLeg, 'failed', busy.join('; '))
  }
  else
  {
    record(busyLeg, 'passed', 'rename and unlink failed with EBUSY while the file was open without sharing and worked once it closed')
  }
  record(trashLeg, trash.status, trash.detail)
}

/** The `\\localhost\X$` form of a local path, which names the same folder through a UNC path. */
function adminSharePath(folder)
{
  const resolved = path.win32.resolve(folder)
  return /^[A-Za-z]:\\/.test(resolved) ? `\\\\localhost\\${resolved[0].toUpperCase()}$${resolved.slice(2)}` : null
}

async function driveKinds(tempFolder, share)
{
  if (!IS_WINDOWS)
  {
    record('drive info: UNC path', 'skipped', 'the DriveInfo query runs on Windows only')
    record('drive info: mapped drive', 'skipped', 'the DriveInfo query runs on Windows only')
    return { local: null, share: null }
  }
  let volumes
  try
  {
    volumes = await loadVolumes()
  }
  catch (err)
  {
    record('drive info: UNC path', 'failed', `could not load src/main/jobs/volumes.ts: ${messageOf(err)}`)
    record('drive info: mapped drive', 'failed', 'the volume module did not load')
    return { local: null, share: null }
  }
  const query = await volumeQuery(volumes)
  const infoOf = (target) => volumes.windowsVolumeInfo(volumes.volumeRoot(target, 'win32'), query)
  const local = infoOf(tempFolder)

  const unc = share && volumes.isUncPath(share, 'win32') ? share : adminSharePath(tempFolder)
  if (unc === null)
  {
    record('drive info: UNC path', 'skipped', 'no UNC path to check')
  }
  else
  {
    const info = infoOf(unc)
    const status = info.kind === 'network' && info.trash === 'unavailable' ? 'passed' : 'failed'
    record('drive info: UNC path', status, `${unc} reports kind '${info.kind}', trash '${info.trash}'`)
  }

  const shareDrive = share && /^[A-Za-z]:/.test(share) ? `${share[0].toUpperCase()}:\\` : null
  const networkDrives = query.drives.filter((d) => d.type === 'Network').map((d) => d.name)
  const mapped = shareDrive ?? networkDrives[0] ?? null
  if (mapped === null)
  {
    record('drive info: mapped drive', 'skipped', 'no mapped network drive exists on this machine; map one and pass a folder on it as the share')
  }
  else
  {
    const info = volumes.windowsVolumeInfo(mapped, query)
    const status = info.kind === 'network' && info.trash === 'unavailable' ? 'passed' : 'failed'
    const hint = status === 'failed' && mapped === shareDrive ? ' (the share folder given is on this drive; pass a folder on a mapped network drive or a UNC path)' : ''
    record('drive info: mapped drive', status, `${mapped} reports kind '${info.kind}', trash '${info.trash}'${hint}`)
  }
  return { local, share: share ? infoOf(share) : null }
}

/**
 * The work folder inside the temp folder, made before Electron is ready so its user data, session data, crash dumps,
 * and logs live there too; null when the temp folder is missing.
 */
function prepareSession()
{
  if (!tempArg)
  {
    return null
  }
  const temp = path.resolve(tempArg)
  if (!existsSync(temp) || !statSync(temp).isDirectory())
  {
    return null
  }
  const folder = path.join(temp, `molex-smoke-${token}`)
  mkdirSync(folder)
  const session = path.join(folder, 'electron')
  app.setPath('userData', session)
  app.setPath('sessionData', session)
  app.setPath('crashDumps', path.join(session, 'crashes'))
  app.setPath('logs', path.join(session, 'logs'))
  app.disableHardwareAcceleration()
  return folder
}

const sessionFolder = prepareSession()

async function main()
{
  if (!tempArg)
  {
    usage('A temp folder is required.')
    return
  }
  if (sessionFolder === null)
  {
    usage(`${path.resolve(tempArg)} is not a folder.`)
    return
  }
  console.log(`molexMedia trash smoke: Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}; token ${token}`)
  const folder = sessionFolder
  try
  {
    const share = shareArg ? path.resolve(shareArg) : null
    const { local, share: shareInfo } = await driveKinds(folder, share)
    if (local !== null && local.kind !== 'local')
    {
      record('drive info: temp folder', 'failed', `the temp folder's volume reports kind '${local.kind}'; give a folder on a local disk`)
    }
    await localTrash(folder, local)
    await shareTrash(share, shareInfo)
    await locks(folder)
  }
  catch (err)
  {
    record('smoke', 'failed', `stopped early: ${messageOf(err)}`)
  }
  finally
  {
    await fs.rm(folder, { recursive: true, force: true }).catch((err) => record('cleanup', 'failed', `could not remove ${folder}: ${messageOf(err)}`))
  }
  const failed = results.filter((r) => r.status === 'failed')
  const skipped = results.filter((r) => r.status === 'skipped')
  console.log(JSON.stringify({ token, results }, null, 2))
  if (skipped.length > 0)
  {
    console.log(`Skipped, for the owner to run: ${skipped.map((r) => r.leg).join(', ')}`)
  }
  app.exit(failed.length > 0 ? 1 : 0)
}

const watchdog = setTimeout(() =>
{
  console.error(`The smoke run took longer than ${WATCHDOG_MS} ms`)
  app.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

app.whenReady().then(main).catch((err) =>
{
  console.error(messageOf(err))
  app.exit(1)
})
