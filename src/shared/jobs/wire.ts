/**
 * Wire safety for data that leaves the job engine: event batches sent to windows and lines and snapshots written to
 * disk. Structured clone keeps NaN, Infinity, and undefined while JSON turns the first two into null and drops the
 * third, so without normalizing, live state and recovered state would differ.
 */

/** A value both structured clone and JSON carry unchanged. */
export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue }

function isPlainObject(value: object): boolean
{
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalize(value: unknown, ancestors: Set<object>): unknown
{
  if (value === undefined)
  {
    return null
  }
  if (typeof value === 'number')
  {
    if (!Number.isFinite(value))
    {
      return null
    }
    return value === 0 ? 0 : value
  }
  if (typeof value !== 'object' || value === null)
  {
    return value
  }
  const isArray = Array.isArray(value)
  if (!isArray && !isPlainObject(value))
  {
    return value
  }
  if (ancestors.has(value))
  {
    throw new TypeError('toWire: the value contains a cycle')
  }
  ancestors.add(value)
  let copy: unknown
  if (isArray)
  {
    const items = value as unknown[]
    const out: unknown[] = new Array(items.length)
    for (let i = 0; i < items.length; i += 1)
    {
      out[i] = normalize(items[i], ancestors)
    }
    copy = out
  }
  else
  {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value))
    {
      out[key] = normalize((value as Record<string, unknown>)[key], ancestors)
    }
    copy = out
  }
  ancestors.delete(value)
  return copy
}

/**
 * A copy of plain data with every non-finite number and every undefined (object values and array holes) turned into
 * null, and -0 into 0. Values that are not plain data (a Map, a Date, a class instance) are passed through for
 * assertWireSafe to reject. Throws on a cycle.
 */
export function toWire<T>(value: T): T
{
  return normalize(value, new Set()) as T
}

function hazardOf(value: unknown): string | null
{
  switch (typeof value)
  {
    case 'undefined':
      return 'undefined'
    case 'number':
      return Number.isFinite(value) ? null : `the non-finite number ${value}`
    case 'bigint':
      return 'a bigint'
    case 'symbol':
      return 'a symbol'
    case 'function':
      return 'a function'
    default:
      break
  }
  if (value instanceof Map)
  {
    return 'a Map'
  }
  if (value instanceof Set)
  {
    return 'a Set'
  }
  if (value instanceof Date)
  {
    return 'a Date'
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value))
  {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } }).constructor?.name
    return `an instance of ${name || 'a class'}`
  }
  return null
}

function check(value: unknown, path: string, ancestors: Set<object>): void
{
  const problem = hazardOf(value)
  if (problem)
  {
    throw new TypeError(`Not wire safe at ${path}: ${problem}`)
  }
  if (typeof value !== 'object' || value === null)
  {
    return
  }
  if (ancestors.has(value))
  {
    throw new TypeError(`Not wire safe at ${path}: a cycle`)
  }
  ancestors.add(value)
  if (Array.isArray(value))
  {
    if (Object.getPrototypeOf(value) !== Array.prototype)
    {
      throw new TypeError(`Not wire safe at ${path}: an array subclass`)
    }
    for (let i = 0; i < value.length; i += 1)
    {
      if (!(i in value))
      {
        throw new TypeError(`Not wire safe at ${path}[${i}]: a hole`)
      }
      check(value[i], `${path}[${i}]`, ancestors)
    }
  }
  else
  {
    for (const key of Object.keys(value))
    {
      check((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
    }
  }
  ancestors.delete(value)
}

/**
 * Throws a TypeError naming the path of the first hazard: undefined, a non-finite number, a bigint, a symbol, a
 * function, a Map, a Set, a Date, a class instance, an array subclass or hole, or a cycle.
 */
export function assertWireSafe(value: unknown, path: string = '$'): void
{
  check(value, path, new Set())
}
