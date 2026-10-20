/**
 * Measures which video encoder each output container can hold, on each FFmpeg build, and writes the fixture the
 * muxing table is checked against.
 *
 *   node scripts/measure-muxers.mjs <out.json> <workDir> <label=ffmpeg> [<label=ffmpeg> ...]
 *
 * Every pair encodes 0.4 s of testsrc2 (128x96, 10 fps, no audio) to out.<ext> inside <workDir>/<label>/<encoder>/,
 * reads the stream's codec name back with ffprobe, then decodes the file in full to null. A pair is:
 *
 *   ok           the encode exits 0, ffprobe reports the encoder's codec, and the decode is clean
 *   refused      the encode fails; the message is FFmpeg's reason
 *   unreadable   the encode exits 0, but the file probes as another codec or fails to decode
 *   no-muxer     FFmpeg has no muxer for the extension
 *
 * Messages keep FFmpeg's first relevant line only: muxer addresses such as [mp4 @ 0x...] are dropped, and nothing is
 * written while a message still holds a drive letter or an absolute path. ffprobe is taken from beside each ffmpeg.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ENCODERS =
{
  'libx264': { codec: 'h264', args: ['-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] },
  'libx265': { codec: 'hevc', args: ['-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error'] },
  'libvpx-vp9': { codec: 'vp9', args: ['-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k'] },
  'libaom-av1': { codec: 'av1', args: ['-cpu-used', '8', '-crf', '45', '-b:v', '0'] },
  'libsvtav1': { codec: 'av1', args: ['-preset', '12', '-crf', '45'] },
  'prores_ks': { codec: 'prores', args: ['-pix_fmt', 'yuv422p10le'] },
  'ffv1': { codec: 'ffv1', args: [] },
  'utvideo': { codec: 'utvideo', args: ['-pix_fmt', 'yuv420p'] },
  'mpeg2video': { codec: 'mpeg2video', args: ['-pix_fmt', 'yuv420p'] },
  'mpeg4': { codec: 'mpeg4', args: ['-pix_fmt', 'yuv420p'] },
  'libtheora': { codec: 'theora', args: ['-pix_fmt', 'yuv420p'] },
  'wmv2': { codec: 'wmv2', args: ['-pix_fmt', 'yuv420p'] }
}

const EXTENSIONS =
[
  'mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'vob', '3gp', 'mts', 'm2ts', 'divx', 'f4v',
  'ogv', 'rm', 'rmvb', 'asf'
]

const LETTERS = { 'ok': 'o', 'refused': 'r', 'unreadable': 'u', 'no-muxer': 'n' }

const NO_MUXER = /Unable to (find a suitable|choose an) output format/

const LOCAL_PATH = /[A-Za-z]:[\\/]|\\\\|(^|[\s'"])\/(Users|home|tmp|var|private)\//

function run(bin, args, cwd, timeoutMs = 120000)
{
  return new Promise((resolve) =>
  {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (data) =>
    {
      out += data
    })
    child.stderr.on('data', (data) =>
    {
      err += data
    })
    child.on('close', (code) =>
    {
      clearTimeout(timer)
      resolve({ code, out: out.trim(), err: err.trim() })
    })
    child.on('error', (error) =>
    {
      clearTimeout(timer)
      resolve({ code: -1, out: '', err: String(error) })
    })
  })
}

/** FFmpeg's first relevant stderr line, without the [muxer @ address] tags; encoder banners such as Svt[info] are skipped. */
function reason(text)
{
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]@]*@ (0x)?[0-9a-fA-F]+\]\s*/g, '').trim())
    .filter((line) => line !== '' && !/^Svt\[/.test(line))
  if (lines.length === 0)
  {
    return ''
  }
  const first = lines[0].endsWith(',') && lines.length > 1 ? `${lines[0]} ${lines[1]}` : lines[0]
  return first.slice(0, 200)
}

async function measure(job)
{
  const encoder = ENCODERS[job.encoder]
  const dir = path.join(job.workDir, job.label, job.encoder)
  const file = `out.${job.ext}`
  fs.mkdirSync(dir, { recursive: true })
  fs.rmSync(path.join(dir, file), { force: true })
  const encode = await run(job.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=d=0.4:s=128x96:r=10',
    '-c:v', job.encoder, ...encoder.args, '-an', '-y', file], dir)
  if (encode.code !== 0)
  {
    const message = reason(encode.err) || `exit ${encode.code}`
    return { status: NO_MUXER.test(message) ? 'no-muxer' : 'refused', message }
  }
  const probe = await run(job.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], dir)
  const got = (probe.out.split(/\r?\n/)[0] ?? '').split(',')[0].trim()
  if (got !== encoder.codec)
  {
    const detail = reason(probe.err)
    return { status: 'unreadable', message: `probes as '${got || 'nothing'}'${detail ? `; ${detail}` : ''}` }
  }
  const decode = await run(job.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], dir)
  if (decode.code !== 0 || decode.err !== '')
  {
    return { status: 'unreadable', message: reason(decode.err) || `decode exit ${decode.code}` }
  }
  return { status: 'ok', message: '' }
}

async function main()
{
  const [outJson, workDir, ...pairs] = process.argv.slice(2)
  if (!outJson || !workDir || pairs.length === 0 || pairs.some((pair) => !pair.includes('=')))
  {
    console.error('usage: node scripts/measure-muxers.mjs <out.json> <workDir> <label=ffmpeg> [<label=ffmpeg> ...]')
    process.exit(2)
  }
  const builds = pairs.map((pair) =>
  {
    const at = pair.indexOf('=')
    const ffmpeg = path.resolve(pair.slice(at + 1))
    return { label: pair.slice(0, at), ffmpeg, ffprobe: ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') }
  })
  const root = path.resolve(workDir)
  const jobs = builds.flatMap((build) => Object.keys(ENCODERS).flatMap((encoder) =>
    EXTENSIONS.map((ext) => ({ ...build, workDir: root, encoder, ext }))))

  const results = Object.fromEntries(builds.map((build) =>
    [build.label, Object.fromEntries(Object.keys(ENCODERS).map((encoder) => [encoder, {}]))]))
  let next = 0
  let done = 0
  async function worker()
  {
    while (next < jobs.length)
    {
      const job = jobs[next++]
      results[job.label][job.encoder][job.ext] = await measure(job)
      done++
      if (done % 50 === 0)
      {
        console.error(`${done}/${jobs.length}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))

  for (const build of builds)
  {
    for (const encoder of Object.keys(ENCODERS))
    {
      const row = results[build.label][encoder]
      results[build.label][encoder] = Object.fromEntries(EXTENSIONS.map((ext) => [ext, row[ext]]))
    }
  }

  const versions = {}
  for (const build of builds)
  {
    const version = await run(build.ffmpeg, ['-hide_banner', '-version'], root)
    versions[build.label] = (version.out.split(/\r?\n/)[0] ?? '').replace(/\s+Copyright.*$/, '').trim()
  }

  const fixture = { measured: new Date().toISOString().slice(0, 10), versions, encoders: ENCODERS, extensions: EXTENSIONS, results }
  const text = `${JSON.stringify(fixture, null, 2)}\n`
  const leaks = text.split('\n').filter((line) => LOCAL_PATH.test(line))
  if (leaks.length > 0)
  {
    console.error(`not written: ${leaks.length} lines still hold a local path, first: ${leaks[0].trim()}`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true })
  fs.writeFileSync(outJson, text)

  for (const build of builds)
  {
    console.log(`\n${build.label}: ${versions[build.label]}`)
    console.log(`${''.padEnd(12)}${EXTENSIONS.map((ext) => ext.padStart(5)).join('')}`)
    for (const encoder of Object.keys(ENCODERS))
    {
      const row = EXTENSIONS.map((ext) => LETTERS[results[build.label][encoder][ext].status].padStart(5)).join('')
      console.log(`${encoder.padEnd(12)}${row}`)
    }
  }
}

await main()
