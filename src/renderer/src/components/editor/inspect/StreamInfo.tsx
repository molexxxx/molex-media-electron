/**
 * @module editor/inspect/StreamInfo
 * Inspect's quiet name and value lists: the plain value first in primary ink, the technical value after it in
 * secondary ink, and a Copy button on each row that shows on hover and focus. Each stream has its Keep in the copy box.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react'
import { Checkbox } from '../../../ui/Checkbox'
import { IconButton } from '../../../ui/IconButton'
import { useAnnounce } from '../../../ui/LiveRegion'
import { streamFacts, streamTitle, type Fact, type ReportStream } from './report'

/** How long a Copy button shows that it copied, in ms. */
export const COPIED_MS = 1500

/** Writes text to the clipboard, announces it, and remembers which row was copied for a moment. */
export function useCopy(): { copied: string | null, copy: (key: string, text: string, what: string) => void }
{
  const announce = useAnnounce()
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const copy = useCallback((key: string, text: string, what: string) =>
  {
    void navigator.clipboard.writeText(text).then(() =>
    {
      announce(`Copied ${what}`)
      setCopied(key)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
    }, () => announce(`Could not copy ${what}. Try again.`))
  }, [announce])
  return { copied, copy }
}

/** The text a row copies: the plain value, with the technical value in parentheses. */
export function factText(fact: Fact): string
{
  return fact.detail ? `${fact.value} (${fact.detail})` : fact.value
}

interface FactListProps
{
  facts: readonly Fact[]
  label: string
  /** Makes each row's key unique for the copied state. */
  scope: string
  copied: string | null
  onCopy: (key: string, text: string, what: string) => void
}

/** A list of facts spanning its pane, one row each. */
export function FactList({ facts, label, scope, copied, onCopy }: FactListProps): ReactElement
{
  return (
    <dl aria-label={label} className="flex flex-col">
      {facts.map((fact) =>
      {
        const key = `${scope}:${fact.name}`
        const done = copied === key
        return (
          <div key={fact.name} className="group grid min-h-8 grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-4 rounded-sm px-2 hover:bg-wash-hover focus-within:bg-wash-hover">
            <dt className="text-body text-ink-3">{fact.name}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 text-body text-ink">{fact.value}</span>
              {fact.detail ? <span className="min-w-0 truncate font-mono text-label text-ink-3">{fact.detail}</span> : null}
              <IconButton
                size="sm"
                label={done ? `Copied ${fact.name.toLowerCase()}` : `Copy ${fact.name.toLowerCase()}`}
                icon={done ? 'action.acknowledge' : 'action.copy'}
                className={done ? undefined : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}
                onClick={() => onCopy(key, factText(fact), `the ${fact.name.toLowerCase()}`)}
              />
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

interface StreamSectionProps
{
  stream: ReportStream
  kept: boolean
  onToggle: (index: number) => void
  copied: string | null
  onCopy: (key: string, text: string, what: string) => void
}

/** One stream: its kind and number, the Keep box, and its facts. */
export function StreamSection({ stream, kept, onToggle, copied, onCopy }: StreamSectionProps): ReactElement
{
  const title = streamTitle(stream)
  return (
    <section aria-label={`${title}, stream ${stream.index}`} data-stream={stream.index} className="flex flex-col gap-1 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="text-body font-semibold text-ink">{title}</h4>
          <span className="text-label tabular-nums text-ink-3">Stream {stream.index}</span>
          {!kept && <span className="text-label text-warning">Left out of the copy</span>}
        </div>
        <Checkbox checked={kept} onChange={() => onToggle(stream.index)}>Keep in the copy</Checkbox>
      </div>
      <div className={kept ? undefined : 'opacity-60'}>
        <FactList facts={streamFacts(stream)} label={`${title}, stream ${stream.index}`} scope={`stream-${stream.index}`} copied={copied} onCopy={onCopy} />
      </div>
    </section>
  )
}
