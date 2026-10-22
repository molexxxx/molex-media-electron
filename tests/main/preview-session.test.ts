/**
 * A stream session on the preview server, with a real child process standing in for FFmpeg: its stdout and pipe:3
 * are served as two URLs, output a client has not asked for yet is held until it does, an output plays once, and
 * the first output's client leaving stops the command.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as http from 'http'

vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn() } }))

import { registerLiveSession, sessionStdio, SESSION_UNCLAIMED_MS, startPreviewServer, stopPreviewServer } from '../../src/main/preview-server'

/** A Node child that writes to stdout and fd 3, then waits. */
function child(script: string): { command: string, args: string[] }
{
  return { command: process.execPath, args: ['-e', script] }
}

interface Answer
{
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(url: string, method = 'GET'): { answer: Promise<Answer>, abort: () => void }
{
  let req: http.ClientRequest | null = null
  const answer = new Promise<Answer>((resolve, reject) =>
  {
    req = http.request(url, { method }, (res) =>
    {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('aborted', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('error', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  return { answer, abort: () => req?.destroy() }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('preview server: stream sessions', () =>
{
  afterEach(() =>
  {
    stopPreviewServer()
    vi.useRealTimers()
  })

  it('gives each further output one more pipe', () =>
  {
    expect(sessionStdio(1)).toEqual(['ignore', 'pipe', 'pipe'])
    expect(sessionStdio(2)).toEqual(['ignore', 'pipe', 'pipe', 'pipe'])
  })

  it('serves stdout and pipe:3 as two URLs, holding the second until its client asks', async () =>
  {
    const { command, args } = child("const fs = require('fs'); fs.writeSync(1, 'sound-bytes'); fs.writeSync(3, 'picture-bytes'); setTimeout(() => {}, 400)")
    const [sound, picture] = registerLiveSession({ command, args, outputs: ['audio/mp4', 'video/mp4'] })
    const base = await startPreviewServer()
    const head = await request(`${base}/${picture}`, 'HEAD').answer
    expect(head.status).toBe(200)
    expect(head.headers['content-type']).toBe('video/mp4')
    const soundAnswer = request(`${base}/${sound}`).answer
    await sleep(250)
    const pictureAnswer = request(`${base}/${picture}`).answer
    await sleep(50)
    const again = await request(`${base}/${picture}`).answer
    expect(again.status).toBe(410)
    const [s, p] = await Promise.all([soundAnswer, pictureAnswer])
    expect(s).toMatchObject({ status: 200, body: 'sound-bytes' })
    expect(s.headers['content-type']).toBe('audio/mp4')
    expect(s.headers['accept-ranges']).toBe('none')
    expect(p).toMatchObject({ status: 200, body: 'picture-bytes' })
    expect((await request(`${base}/${sound}`).answer).status).toBe(404)
  })

  it('stops the command when the first output\'s client leaves, ending the others', async () =>
  {
    const { command, args } = child("const fs = require('fs'); fs.writeSync(1, 'a'); fs.writeSync(3, 'b'); setTimeout(() => {}, 20000)")
    const [sound, picture] = registerLiveSession({ command, args, outputs: ['audio/mp4', 'video/mp4'] })
    const base = await startPreviewServer()
    const soundRequest = request(`${base}/${sound}`)
    const pictureAnswer = request(`${base}/${picture}`).answer
    await sleep(400)
    const started = Date.now()
    soundRequest.abort()
    const p = await pictureAnswer
    expect(p.body).toBe('b')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('drops a session nobody asked for', async () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { command, args } = child('setTimeout(() => {}, 10)')
    const [only] = registerLiveSession({ command, args, outputs: ['audio/mp4'] })
    vi.advanceTimersByTime(SESSION_UNCLAIMED_MS + 1)
    vi.useRealTimers()
    const base = await startPreviewServer()
    expect((await request(`${base}/${only}`).answer).status).toBe(404)
  })
})
