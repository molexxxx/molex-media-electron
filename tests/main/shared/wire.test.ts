/**
 * Wire safety. toWire turns non-finite numbers and undefined (object values and array holes) into null, so live
 * state and state read back from disk agree; assertWireSafe names the first value structured clone and JSON would
 * treat differently.
 */
import { describe, it, expect } from 'vitest'
import { assertWireSafe, toWire } from '../../../src/shared/jobs/wire'

class Probe
{
  value = 1
}

describe('toWire', () =>
{
  it('turns NaN, Infinity, and -Infinity into null at any depth', () =>
  {
    expect(toWire({ peak: Number.NEGATIVE_INFINITY, headroom: Number.POSITIVE_INFINITY, ratio: Number.NaN })).toEqual({ peak: null, headroom: null, ratio: null })
    expect(toWire([1, Number.NaN, [Number.POSITIVE_INFINITY]])).toEqual([1, null, [null]])
    expect(toWire(Number.NaN)).toBeNull()
  })

  it('turns undefined object values and array holes into null', () =>
  {
    const holes: Array<number | undefined> = [1, 2, 3]
    delete holes[1]
    const result = toWire({ a: undefined, list: holes, nested: { b: undefined } })
    expect(result).toEqual({ a: null, list: [1, null, 3], nested: { b: null } })
    expect(Object.keys(result)).toEqual(['a', 'list', 'nested'])
    expect(1 in result.list).toBe(true)
    expect(toWire(undefined)).toBeNull()
  })

  it('leaves plain data unchanged, in a new copy', () =>
  {
    const event =
    {
      type: 'job.progress',
      jobId: 'MM-0142',
      seq: 41,
      percent: 37.5,
      speed: null,
      done: false,
      stages: [{ name: 'Encode', pass: 1 }, { name: 'Verify', pass: 1 }],
      bare: Object.assign(Object.create(null) as Record<string, unknown>, { x: 1 }),
      empty: {},
      none: []
    }
    const wire = toWire(event)
    expect(wire).toEqual(event)
    expect(wire).not.toBe(event)
    expect(wire.stages).not.toBe(event.stages)
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
    expect(structuredClone(wire)).toEqual(wire)
  })

  it('turns -0 into 0', () =>
  {
    expect(Object.is(toWire(-0), 0)).toBe(true)
    expect(Object.is(toWire({ v: -0 }).v, 0)).toBe(true)
  })

  it('passes values that are not plain data through for assertWireSafe to reject', () =>
  {
    const map = new Map([['a', 1]])
    const when = new Date(0)
    const probe = new Probe()
    const result = toWire({ map, when, probe })
    expect(result.map).toBe(map)
    expect(result.when).toBe(when)
    expect(result.probe).toBe(probe)
  })

  it('copies a shared object twice but refuses a cycle', () =>
  {
    const shared = { n: 1 }
    expect(toWire({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } })
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    expect(() => toWire(loop)).toThrow(TypeError)
    const list: unknown[] = []
    list.push(list)
    expect(() => toWire(list)).toThrow('cycle')
  })

  it('makes data that assertWireSafe accepts', () =>
  {
    const raw = { truePeakDbtp: Number.NEGATIVE_INFINITY, eta: undefined, history: [Number.NaN, 2] }
    expect(() => assertWireSafe(raw)).toThrow()
    expect(() => assertWireSafe(toWire(raw))).not.toThrow()
  })
})

describe('assertWireSafe', () =>
{
  it('accepts plain data', () =>
  {
    expect(() => assertWireSafe({ a: [1, 'two', null, true, { b: -3.5 }], c: Object.create(null) })).not.toThrow()
    expect(() => assertWireSafe('text')).not.toThrow()
    expect(() => assertWireSafe(null)).not.toThrow()
  })

  it.each([
    ['a Map', { v: new Map() }, '$.v: a Map'],
    ['a Set', { v: new Set([1]) }, '$.v: a Set'],
    ['a Date', { v: new Date(0) }, '$.v: a Date'],
    ['a class instance', { v: new Probe() }, '$.v: an instance of Probe'],
    ['an Error', { v: new Error('x') }, '$.v: an instance of Error'],
    ['a function', { v: (): number => 1 }, '$.v: a function'],
    ['NaN', { v: Number.NaN }, '$.v: the non-finite number NaN'],
    ['Infinity', { v: [0, Number.POSITIVE_INFINITY] }, '$.v[1]: the non-finite number Infinity'],
    ['-Infinity', { deep: { v: Number.NEGATIVE_INFINITY } }, '$.deep.v: the non-finite number -Infinity'],
    ['undefined', { v: undefined }, '$.v: undefined'],
    ['a bigint', { v: BigInt(1) }, '$.v: a bigint'],
    ['a symbol', { v: Symbol('s') }, '$.v: a symbol']
  ])('rejects %s and names its path', (_name, value, message) =>
  {
    expect(() => assertWireSafe(value)).toThrow(`Not wire safe at ${message}`)
  })

  it('rejects array holes, array subclasses, and cycles', () =>
  {
    const holes = [1, 2, 3]
    delete holes[1]
    expect(() => assertWireSafe({ list: holes })).toThrow('$.list[1]: a hole')
    class Rows extends Array<number> {}
    expect(() => assertWireSafe(Rows.from([1]))).toThrow('an array subclass')
    const loop: Record<string, unknown> = {}
    loop.again = { back: loop }
    expect(() => assertWireSafe(loop)).toThrow('$.again.back: a cycle')
  })

  it('accepts the same object reached twice without a cycle', () =>
  {
    const shared = { n: 1 }
    expect(() => assertWireSafe({ a: shared, b: [shared] })).not.toThrow()
  })

  it('names an instance of a class without a constructor name', () =>
  {
    const anonymous = Object.create({ constructor: undefined }) as object
    expect(() => assertWireSafe(anonymous, 'root')).toThrow('Not wire safe at root: an instance of a class')
  })
})
