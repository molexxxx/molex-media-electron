/** One class name fragment; a falsy fragment is skipped, so conditions can be written inline. */
export type ClassValue = string | false | null | undefined | 0

/** Joins class name fragments with single spaces, skipping falsy and empty ones. */
export function cx(...values: ClassValue[]): string
{
  let out = ''
  for (const value of values)
  {
    if (!value)
    {
      continue
    }
    out = out ? `${out} ${value}` : value
  }
  return out
}
