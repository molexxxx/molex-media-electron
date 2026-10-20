/**
 * Records FFmpeg output fixtures for the unit tests, byte for byte.
 *
 *   node scripts/capture-ffmpeg-fixtures.mjs <ffmpeg binary> <fixture folder> [--label <name>] [--inputs <folder>]
 *
 * The fixture folder holds a scenarios.json. Results land in <fixture folder>/<label>/, where the label comes from
 * the build's version line (9.0.2, 2022-10-13) unless --label names it, and replace what that folder held. Every
 * command runs in a temporary folder with relative IN/ and OUT/ names; absolute paths left in the output are
 * rewritten to IN/<name> or OUT/<name>, and nothing is written if any output still holds a drive letter, a home
 * folder, or a hidden folder path. Pass machine paths on the command line only, never inside scenarios.json.
 *
 * scenarios.json:
 *
 *   {
 *     "prefix": ["-hide_banner", "-nostdin"],    optional: put before the args of every ffmpeg run
 *     "inputs": [                                optional: files made in IN/ before the runs
 *       { "name": "tone.wav", "args": ["-f", "lavfi", "-i", "sine=duration=1"] },    encoded by this build
 *       { "name": "song.flac", "copy": "song.flac" }                                copied from --inputs
 *     ],
 *     "runs": [
 *       {
 *         "name": "collision",                   file name stem: lowercase letters, digits, dots, hyphens
 *         "tool": "ffmpeg",                      optional: "ffmpeg" (default) or "ffprobe" from the same folder
 *         "args": ["-i", "IN/tone.wav", "-n", "OUT/exists.wav"],
 *         "files": { "OUT/exists.wav": "x" },    optional: text files written before the run
 *         "timeoutMs": 60000                     optional: a run still going after this is killed
 *       }
 *     ]
 *   }
 *
 * Each run writes <name>.stdout.txt and <name>.stderr.txt when they are not empty, and runs.json records the
 * version line, the platform, and every run's argv, raw exit code, and signal. OUT/ is emptied before each run.
 * A run killed at its timeout or ended by a signal fails the capture before anything is written, so the label
 * folder keeps its previous recording.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USAGE = 'Usage: node scripts/capture-ffmpeg-fixtures.mjs <ffmpeg binary> <fixture folder> [--label <name>] [--inputs <folder>]'
const NAME = /^[a-z0-9][a-z0-9.-]*$/
const RELATIVE_FILE = /^(?:IN|OUT)\/(?!\.)[^\\/:*?"<>|\u0000-\u001f]+$/

class CaptureError extends Error
{
}

function fail(message)
{
  throw new CaptureError(message)
}

function parseArgs(argv)
{
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++)
  {
    const arg = argv[i]
    if (arg === '--label' || arg === '--inputs')
    {
      if (i + 1 >= argv.length)
      {
        fail(USAGE)
      }
      flags[arg.slice(2)] = argv[++i]
    }
    else if (arg.startsWith('--'))
    {
      fail(`Unknown option ${arg}\n${USAGE}`)
    }
    else
    {
      positional.push(arg)
    }
  }
  if (positional.length !== 2)
  {
    fail(USAGE)
  }
  return {
    ffmpeg: path.resolve(positional[0]),
    folder: path.resolve(positional[1]),
    label: flags.label,
    inputs: flags.inputs === undefined ? undefined : path.resolve(flags.inputs)
  }
}

function readScenarios(folder)
{
  const file = path.join(folder, 'scenarios.json')
  if (!fs.existsSync(file))
  {
    fail(`No scenarios.json in ${folder}`)
  }
  const scenarios = JSON.parse(fs.readFileSync(file, 'utf8'))
  const prefix = scenarios.prefix ?? []
  const inputs = scenarios.inputs ?? []
  const runs = scenarios.runs ?? []
  const seen = new Set()
  for (const input of inputs)
  {
    if (typeof input.name !== 'string' || !RELATIVE_FILE.test(`IN/${input.name}`))
    {
      fail(`Input name ${JSON.stringify(input.name)} is not a plain file name`)
    }
    if (!Array.isArray(input.args) && typeof input.copy !== 'string')
    {
      fail(`Input ${input.name} needs args or copy`)
    }
  }
  for (const run of runs)
  {
    if (typeof run.name !== 'string' || !NAME.test(run.name) || seen.has(run.name))
    {
      fail(`Run name ${JSON.stringify(run.name)} is missing, repeated, or not lowercase letters, digits, dots, and hyphens`)
    }
    seen.add(run.name)
    if (!Array.isArray(run.args) || !run.args.every((arg) => typeof arg === 'string'))
    {
      fail(`Run ${run.name} needs args as an array of strings`)
    }
    if (run.tool !== undefined && run.tool !== 'ffmpeg' && run.tool !== 'ffprobe')
    {
      fail(`Run ${run.name} has an unknown tool ${JSON.stringify(run.tool)}`)
    }
    for (const name of Object.keys(run.files ?? {}))
    {
      if (!RELATIVE_FILE.test(name))
      {
        fail(`Run ${run.name} writes ${JSON.stringify(name)}, which is not IN/<name> or OUT/<name>`)
      }
    }
  }
  return { prefix, inputs, runs }
}

function execute(file, args, cwd, timeoutMs)
{
  return new Promise((resolve, reject) =>
  {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    let timedOut = false
    const timer = setTimeout(() =>
    {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) =>
    {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) =>
    {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

/** Fails the capture for a process that was killed, so truncated output never replaces a recorded fixture. */
function requireFinished(result, what, timeoutMs)
{
  if (result.timedOut)
  {
    fail(`${what} was still running after ${timeoutMs} ms and was killed. Nothing written; raise its timeoutMs.`)
  }
  if (result.signal !== null)
  {
    fail(`${what} ended by signal ${result.signal}. Nothing written.`)
  }
}

function labelFor(versionLine)
{
  const token = /^ffmpeg version (\S+)/.exec(versionLine)?.[1]
  if (token === undefined)
  {
    fail(`Not an FFmpeg version line: ${versionLine}`)
  }
  const release = /^n?(\d+\.\d+(?:\.\d+)?)(?:[-_~]|$)/.exec(token)
  const dated = /^(\d{4}-\d{2}-\d{2})-/.exec(token)
  const master = /^(N-\d+)/.exec(token)
  return (release ?? dated ?? master)?.[1] ?? token.replace(/[^\w.-]+/g, '_')
}

function escapeRegExp(text)
{
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathForms(folder)
{
  const forms = new Set()
  for (const base of [folder, fs.realpathSync.native(folder)])
  {
    const back = base.replace(/\//g, '\\')
    const forward = base.replace(/\\/g, '/')
    forms.add(back)
    forms.add(forward)
    forms.add(back.replace(/\\/g, '\\\\'))
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

function rewritePaths(bytes, forms)
{
  let text = bytes.toString('latin1')
  for (const form of forms)
  {
    const needle = escapeRegExp(asBytes(form))
    text = text.replace(new RegExp(`${needle}[\\\\/]+(IN|OUT)[\\\\/]+`, 'gi'), '$1/')
    text = text.replace(new RegExp(needle, 'gi'), '.')
  }
  return Buffer.from(text, 'latin1')
}

function asBytes(text)
{
  return Buffer.from(text, 'utf8').toString('latin1')
}

function leaksIn(text)
{
  const homeForms = pathForms(os.homedir()).map((form) => escapeRegExp(asBytes(form)))
  const checks = [
    ['a drive letter path', /(?<![A-Za-z])[A-Za-z]:[\\/]/],
    ['a home folder', new RegExp(homeForms.join('|'), 'i')],
    ['a users or home folder', /[\\/](?:Users|home)[\\/]/i],
    ['a hidden folder path', /(?:^|[\\/\s'"=:])\.[A-Za-z][\w-]*[\\/]/m]
  ]
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

function emptyFolder(folder)
{
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
}

async function main()
{
  const options = parseArgs(process.argv.slice(2))
  const scenarios = readScenarios(options.folder)
  if (!fs.existsSync(options.ffmpeg))
  {
    fail(`No FFmpeg binary at the path given`)
  }
  const ffprobe = path.join(path.dirname(options.ffmpeg), `ffprobe${path.extname(options.ffmpeg)}`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-fixtures-'))
  try
  {
    const version = await execute(options.ffmpeg, ['-hide_banner', '-version'], work, 30000)
    requireFinished(version, 'ffmpeg -version', 30000)
    const versionLine = version.stdout.toString('utf8').split(/\r?\n/)[0]
    const label = options.label ?? labelFor(versionLine)
    if (!NAME.test(label.toLowerCase()))
    {
      fail(`The label ${JSON.stringify(label)} is not a plain folder name`)
    }

    emptyFolder(path.join(work, 'IN'))
    for (const input of scenarios.inputs)
    {
      const target = path.join(work, 'IN', input.name)
      if (typeof input.copy === 'string')
      {
        if (options.inputs === undefined)
        {
          fail(`Input ${input.name} is copied, so pass --inputs <folder>`)
        }
        fs.copyFileSync(path.join(options.inputs, input.copy), target)
        continue
      }
      const made = await execute(options.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...input.args, `IN/${input.name}`], work, 120000)
      requireFinished(made, `Making input ${input.name}`, 120000)
      if (made.code !== 0)
      {
        fail(`Making input ${input.name} failed with exit code ${made.code}:\n${made.stderr.toString('utf8')}`)
      }
    }

    const forms = pathForms(work)
    const records = []
    const files = new Map()
    for (const run of scenarios.runs)
    {
      emptyFolder(path.join(work, 'OUT'))
      for (const [name, text] of Object.entries(run.files ?? {}))
      {
        fs.writeFileSync(path.join(work, name), String(text))
      }
      const tool = run.tool ?? 'ffmpeg'
      const argv = tool === 'ffmpeg' ? [...scenarios.prefix, ...run.args] : [...run.args]
      const timeoutMs = run.timeoutMs ?? 60000
      const result = await execute(tool === 'ffmpeg' ? options.ffmpeg : ffprobe, argv, work, timeoutMs)
      console.log(`${run.name}: exit ${result.code}${result.signal ? ` (${result.signal})` : ''}, stdout ${result.stdout.length} bytes, stderr ${result.stderr.length} bytes`)
      requireFinished(result, `Run ${run.name}`, timeoutMs)
      const record = { name: run.name, tool, argv, code: result.code, signal: result.signal, stdout: null, stderr: null }
      for (const stream of ['stdout', 'stderr'])
      {
        if (result[stream].length > 0)
        {
          const file = `${run.name}.${stream}.txt`
          files.set(file, rewritePaths(result[stream], forms))
          record[stream] = file
        }
      }
      records.push(record)
    }
    const manifest = { version: versionLine, label, platform: process.platform, runs: records }
    files.set('runs.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))

    const problems = []
    for (const [file, bytes] of files)
    {
      for (const leak of leaksIn(bytes.toString('latin1')))
      {
        problems.push(`${file} still holds ${leak}`)
      }
    }
    if (problems.length > 0)
    {
      fail(`Nothing written:\n${problems.join('\n')}`)
    }

    const target = path.join(options.folder, label)
    emptyFolder(target)
    for (const [file, bytes] of files)
    {
      fs.writeFileSync(path.join(target, file), bytes)
    }
    console.log(`Wrote ${files.size} files for ${versionLine}`)
  }
  finally
  {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

try
{
  await main()
}
catch (err)
{
  console.error(err instanceof CaptureError ? err.message : err)
  process.exitCode = 1
}
