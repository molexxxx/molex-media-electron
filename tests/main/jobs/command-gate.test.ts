import { describe, expect, it, vi } from 'vitest'
import type { Exec, ExecOptions, ExecResult } from '../../../src/main/ffmpeg/exec'
import { commandRefusal, createCommandGate, type CommandGateDeps, type CommandTarget, type SenderInfo } from '../../../src/main/jobs/command-gate'
import { withSpawnHook } from '../../../src/main/jobs/deps'
import { execEnding } from '../../../src/main/jobs/runners/types'
import type { RendererLocation } from '../../../src/main/jobs/trust'
import { JOB_CHANNELS, JOB_COMMAND_NAMES, type CommandResult, type JobCommandName } from '../../../src/shared/jobs/contract'
import { formatCatalog } from '../../../src/shared/jobs/ids'
import { createRequestValidators, REQUEST_VALIDATORS, type RequestValidators } from '../../../src/shared/jobs/validate'

const INDEX = 'file:///C:/molexMedia/out/renderer/index.html'
const EXPECTED: RendererLocation = { kind: 'file', url: INDEX }
const TRUSTED: SenderInfo = { frameUrl: `${INDEX}#popout`, isMainFrame: true, senderId: 7 }
const JOB = formatCatalog(1)

interface Call
{
  name: JobCommandName
  req: unknown
  ctx: { senderId: number }
}

function fakeEngine(answer: (name: JobCommandName, req: unknown) => Promise<CommandResult<unknown>> = async () => ({ ok: true, value: null, seq: 0 }))
{
  const calls: Call[] = []
  const engine =
  {
    command: (name: JobCommandName, req: unknown, ctx: { senderId: number }) =>
    {
      calls.push({ name, req, ctx })
      return answer(name, req)
    }
  } as unknown as CommandTarget
  return { engine, calls }
}

function gateWith(overrides: Partial<CommandGateDeps> = {})
{
  const { engine, calls } = fakeEngine()
  const logUnexpected = vi.fn()
  const deps: CommandGateDeps = { engine, expected: EXPECTED, validators: createRequestValidators('win32'), logUnexpected, ...overrides }
  return { gate: createCommandGate(deps), calls, logUnexpected }
}

function spyValidators(): { validators: RequestValidators; seen: string[] }
{
  const seen: string[] = []
  const entries = JOB_COMMAND_NAMES.map((name) => [name, (raw: unknown) =>
  {
    seen.push(name)
    return { ok: false, issues: [{ path: '', message: `${name}:${JSON.stringify(raw)}` }] }
  }])
  return { validators: Object.fromEntries(entries) as RequestValidators, seen }
}

describe('createCommandGate sender check', () =>
{
  it.each<[string, SenderInfo]>([
    ['a null frame', { frameUrl: null, isMainFrame: false, senderId: 7 }],
    ['a subframe', { frameUrl: INDEX, isMainFrame: false, senderId: 7 }],
    ['another origin', { frameUrl: 'https://evil.test/', isMainFrame: true, senderId: 7 }],
    ['another local file', { frameUrl: 'file:///C:/Users/me/Downloads/index.html', isMainFrame: true, senderId: 7 }]
  ])('refuses %s before validation', async (_label, sender) =>
  {
    const { validators, seen } = spyValidators()
    const { gate, calls, logUnexpected } = gateWith({ validators })
    const result = await gate('add', { paths: [] }, sender)
    expect(result).toEqual({ ok: false, error: { code: 'untrusted-sender', message: expect.any(String), issues: [], details: null } })
    expect(seen).toEqual([])
    expect(calls).toEqual([])
    expect(logUnexpected).not.toHaveBeenCalled()
  })
})

describe('createCommandGate validation', () =>
{
  it('answers an invalid payload with every issue and never reaches the engine', async () =>
  {
    const validators = createRequestValidators('win32')
    const raw = { paths: 'C:\\a.mkv', recipe: 5, origin: 'nowhere', after: 1, recursive: 'yes', allowSecondJobs: null, force: 'no' }
    const direct = validators.add(raw)
    expect(direct.ok).toBe(false)
    const issues = direct.ok ? [] : direct.issues
    expect(issues.length).toBeGreaterThan(3)
    const { gate, calls } = gateWith({ validators })
    const result = await gate('add', raw, TRUSTED)
    expect(result).toEqual({ ok: false, error: { code: 'invalid-payload', message: expect.any(String), issues, details: null } })
    expect(calls).toEqual([])
  })

  it('validates each command with its own validator', async () =>
  {
    const { validators, seen } = spyValidators()
    const { gate } = gateWith({ validators })
    for (const name of JOB_COMMAND_NAMES)
    {
      const result = await gate(name, { probe: name }, TRUSTED)
      expect(result.ok).toBe(false)
      if (!result.ok)
      {
        expect(result.error.issues).toEqual([{ path: '', message: `${name}:${JSON.stringify({ probe: name })}` }])
      }
    }
    expect(seen).toEqual(JOB_COMMAND_NAMES)
  })

  it('refuses a root-relative path on a win32 gate and accepts it on a linux gate', async () =>
  {
    const win = gateWith({ validators: createRequestValidators('win32') })
    const refused = await win.gate('locate', { jobId: JOB, path: '/x/a.mkv' }, TRUSTED)
    expect(refused.ok).toBe(false)
    if (!refused.ok)
    {
      expect(refused.error.code).toBe('invalid-payload')
      expect(refused.error.issues.map((issue) => issue.path)).toEqual(['path'])
    }
    expect(win.calls).toEqual([])

    const accepted = await win.gate('locate', { jobId: JOB, path: 'C:\\x\\a.mkv' }, TRUSTED)
    expect(accepted.ok).toBe(true)
    expect(win.calls.map((call) => call.req)).toEqual([{ jobId: JOB, path: 'C:\\x\\a.mkv' }])

    const linux = gateWith({ validators: createRequestValidators('linux') })
    expect((await linux.gate('locate', { jobId: JOB, path: '/x/a.mkv' }, TRUSTED)).ok).toBe(true)
  })
})

describe('createCommandGate engine calls', () =>
{
  it('forwards the validated request with the sender id and returns the engine result as is', async () =>
  {
    const answer: CommandResult<unknown> = { ok: true, value: null, seq: 41 }
    const { engine, calls } = fakeEngine(async () => answer)
    const { gate } = gateWith({ engine })
    const result = await gate('unsubscribe', { clientId: 'client-1' }, TRUSTED)
    expect(result).toBe(answer)
    expect(calls).toEqual([{ name: 'unsubscribe', req: { clientId: 'client-1' }, ctx: { senderId: 7 } }])
  })

  it('passes an expected refusal from the engine through', async () =>
  {
    const refusal = commandRefusal('not-found', 'That job is gone.')
    const { engine } = fakeEngine(async () => refusal)
    const { gate, logUnexpected } = gateWith({ engine })
    expect(await gate('unsubscribe', { clientId: 'client-1' }, TRUSTED)).toBe(refusal)
    expect(logUnexpected).not.toHaveBeenCalled()
  })

  it('answers a rejecting engine with internal and logs the error', async () =>
  {
    const boom = new Error('boom')
    const { engine } = fakeEngine(async () =>
    {
      throw boom
    })
    const { gate, logUnexpected } = gateWith({ engine })
    const result = await gate('unsubscribe', { clientId: 'client-1' }, TRUSTED)
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String), issues: [], details: null } })
    expect(logUnexpected).toHaveBeenCalledWith('unsubscribe', boom)
  })

  it('answers an engine that throws synchronously with internal and logs the error', async () =>
  {
    const boom = new TypeError('sync')
    const engine = { command: () => { throw boom } } as unknown as CommandTarget
    const { gate, logUnexpected } = gateWith({ engine })
    const result = await gate('unsubscribe', { clientId: 'client-1' }, TRUSTED)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('internal')
    expect(logUnexpected).toHaveBeenCalledWith('unsubscribe', boom)
  })

  it('answers a throwing validator or an unknown command with internal', async () =>
  {
    const boom = new Error('validator')
    const validators = { ...createRequestValidators('win32'), get: () => { throw boom } } as RequestValidators
    const { gate, logUnexpected, calls } = gateWith({ validators })
    const thrown = await gate('get', { jobId: JOB }, TRUSTED)
    expect(!thrown.ok && thrown.error.code).toBe('internal')
    expect(logUnexpected).toHaveBeenCalledWith('get', boom)

    const unknown = await gate('missing' as JobCommandName, {}, TRUSTED)
    expect(!unknown.ok && unknown.error.code).toBe('internal')
    expect(logUnexpected).toHaveBeenLastCalledWith('missing', expect.any(TypeError))
    expect(calls).toEqual([])
  })

  it('still answers internal when logging the error fails', async () =>
  {
    const { engine } = fakeEngine(async () =>
    {
      throw new Error('boom')
    })
    const logUnexpected = vi.fn(() =>
    {
      throw new Error('log failed')
    })
    const { gate } = gateWith({ engine, logUnexpected })
    const result = await gate('unsubscribe', { clientId: 'client-1' }, TRUSTED)
    expect(!result.ok && result.error.code).toBe('internal')
    expect(logUnexpected).toHaveBeenCalledTimes(1)
  })
})

describe('request validators', () =>
{
  it.each([
    ['win32', createRequestValidators('win32')],
    ['darwin', createRequestValidators('darwin')],
    ['linux', createRequestValidators('linux')],
    ['any platform', REQUEST_VALIDATORS]
  ] as const)('exist for every command name (%s)', (_label, validators) =>
  {
    expect(Object.keys(validators).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
    expect(Object.keys(JOB_CHANNELS).sort()).toEqual([...JOB_COMMAND_NAMES].sort())
    for (const name of JOB_COMMAND_NAMES)
    {
      expect(typeof validators[name]).toBe('function')
    }
  })
})

describe('commandRefusal', () =>
{
  it('uses the given message, the default message, or the code', () =>
  {
    expect(commandRefusal('invalid-state', 'Pause the batch first.').error.message).toBe('Pause the batch first.')
    expect(commandRefusal('untrusted-sender').error.message).toMatch(/molexMedia/)
    expect(commandRefusal('queue-full')).toEqual({ ok: false, error: { code: 'queue-full', message: 'queue-full', issues: [], details: null } })
  })
})

const DONE: ExecResult = { code: 0, exitName: null, signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: 5 }

function fakeExec(): { exec: Exec; seen: Array<{ args: readonly string[]; o: ExecOptions }> }
{
  const seen: Array<{ args: readonly string[]; o: ExecOptions }> = []
  const exec: Exec =
  {
    run: async (args, o) =>
    {
      seen.push({ args, o })
      o.onSpawn?.(4242)
      return DONE
    }
  }
  return { exec, seen }
}

describe('withSpawnHook', () =>
{
  const signal = new AbortController().signal

  it('calls the hook with the pid, then the caller\'s own onSpawn, and keeps every option', async () =>
  {
    const order: string[] = []
    const { exec, seen } = fakeExec()
    const log = { warn: vi.fn() }
    const hooked = withSpawnHook(exec, (pid) => order.push(`hook ${pid}`), log)
    const onProgress = vi.fn()
    const result = await hooked.run(['-i', 'a.wav'], { signal, stop: 'kill', durationSec: 3, onProgress, onSpawn: (pid) => order.push(`caller ${pid}`) })
    expect(result).toBe(DONE)
    expect(order).toEqual(['hook 4242', 'caller 4242'])
    expect(seen[0].args).toEqual(['-i', 'a.wav'])
    expect(seen[0].o).toMatchObject({ signal, stop: 'kill', durationSec: 3, onProgress })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs a throwing hook and never fails the run', async () =>
  {
    const { exec } = fakeExec()
    const log = { warn: vi.fn() }
    const onSpawn = vi.fn()
    const hooked = withSpawnHook(exec, () =>
    {
      throw new Error('ESRCH')
    }, log)
    await expect(hooked.run([], { signal, stop: 'graceful', onSpawn })).resolves.toBe(DONE)
    expect(onSpawn).toHaveBeenCalledWith(4242)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('4242: ESRCH'))

    const plain = withSpawnHook(exec, () =>
    {
      throw 'no permission'
    }, log)
    await expect(plain.run([], { signal, stop: 'kill' })).resolves.toBe(DONE)
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('no permission'))
  })
})

describe('execEnding', () =>
{
  it.each<[string, Partial<ExecResult>, ReturnType<typeof execEnding>]>([
    ['a clean exit', {}, { kind: 'completed' }],
    ['an aborted run whatever its code', { aborted: true, code: 255, stopped: 'killed', outputRefused: true }, { kind: 'aborted' }],
    ['an existing output refused with code 0', { outputRefused: true }, { kind: 'output-exists' }],
    ['an unknown encoder, which also refuses the output', { code: -22, exitName: 'EINVAL', outputRefused: true },
      { kind: 'failed', exitCode: -22, exitName: 'EINVAL', signal: null }],
    ['a non-zero exit', { code: 1 }, { kind: 'failed', exitCode: 1, exitName: null, signal: null }],
    ['a signal', { code: null, signal: 'SIGKILL' }, { kind: 'failed', exitCode: null, exitName: null, signal: 'SIGKILL' }],
    ['an exit 0 that exec had to stop', { stopped: 'graceful' }, { kind: 'failed', exitCode: 0, exitName: null, signal: null }]
  ])('names %s', (_label, patch, expected) =>
  {
    expect(execEnding({ ...DONE, ...patch })).toEqual(expected)
  })
})
