/**
 * Add link: a popover with one field that checks the address as it is typed, reads site links through yt-dlp with
 * its progress in words, reports failures as the problem and the way out with yt-dlp's own line folded under it,
 * and lists recent links to add again.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type Ref } from 'react'
import type { UrlHistoryEntry } from '../../../../../shared/ipc/api'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import { Popover } from '../../../ui/Popover'
import { ProgressBar } from '../../../ui/ProgressBar'
import { cx } from '../../../ui/cx'
import { PLAYER_COPY } from '../copy'
import { checkLink, foundSentence, lookupSentence, type LinkFailure } from '../engine/links'
import type { LinkOutcome } from '../hooks/usePlayer'

/** How many recent links the popover lists. */
export const RECENT_LINKS_SHOWN = 5

const FIELD = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 text-body text-ink',
  'transition-colors duration-fast ease-out placeholder:text-ink-3',
  'enabled:not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill disabled:text-ink-disabled'
].join(' ')

/** What the popover needs from the page. */
export interface AddLinkProps
{
  onAdd(url: string, kind: 'site' | 'file'): Promise<LinkOutcome>
  /** The trigger, so the page's shortcut and the empty state can open the popover. */
  triggerRef?: Ref<HTMLButtonElement>
  /** Shows only the icon, for narrow headers. */
  iconOnly?: boolean
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading', started: number }
  | { kind: 'failed', failure: LinkFailure }
  | { kind: 'added', count: number }

function LinkForm({ onAdd, close, openSignal }: { onAdd: AddLinkProps['onAdd'], close: () => void, openSignal: number }): ReactElement
{
  const fieldId = useId()
  const messageId = useId()
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<UrlHistoryEntry[]>([])
  const [showDetail, setShowDetail] = useState(false)
  const attempt = useRef(0)
  const check = checkLink(text)
  const reading = phase.kind === 'reading'

  useEffect(() =>
  {
    let alive = true
    void window.api.getUrlHistory?.().then((entries) =>
    {
      if (alive)
      {
        setHistory(entries)
      }
    }).catch(() => undefined)
    setPhase((current) => current.kind === 'reading' ? current : { kind: 'idle' })
    return () =>
    {
      alive = false
    }
  }, [openSignal])

  useEffect(() =>
  {
    if (!reading)
    {
      return undefined
    }
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [reading])

  const submit = async (value: string): Promise<void> =>
  {
    setTouched(true)
    const checked = checkLink(value)
    if (!checked.ok || reading)
    {
      return
    }
    const mine = ++attempt.current
    setShowDetail(false)
    setPhase({ kind: 'reading', started: Date.now() })
    setNow(Date.now())
    const outcome = await onAdd(checked.url, checked.kind)
    if (attempt.current !== mine)
    {
      return
    }
    if (outcome.ok)
    {
      setPhase({ kind: 'added', count: outcome.count })
      setText('')
      setTouched(false)
      close()
      return
    }
    setPhase({ kind: 'failed', failure: outcome.problem })
  }

  const onSubmit = (event: FormEvent): void =>
  {
    event.preventDefault()
    void submit(text)
  }

  const stopWaiting = (): void =>
  {
    attempt.current += 1
    setPhase({ kind: 'idle' })
  }

  const forget = async (url: string): Promise<void> =>
  {
    try
    {
      setHistory(await window.api.removeUrlHistory(url))
    }
    catch
    {
      setHistory((entries) => entries.filter((entry) => entry.url !== url))
    }
  }

  const invalid = touched && !check.ok
  const message = invalid && !check.ok ? check.reason : null
  const elapsed = phase.kind === 'reading' ? (now - phase.started) / 1000 : 0

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-label font-semibold text-ink-2">{PLAYER_COPY.linkLabel}</label>
        <div className="flex items-center gap-2">
          <input
            id={fieldId}
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder={PLAYER_COPY.linkPlaceholder}
            className={FIELD}
            value={text}
            disabled={reading}
            aria-invalid={invalid || undefined}
            aria-describedby={messageId}
            onChange={(event) =>
            {
              setText(event.target.value)
              if (phase.kind === 'failed')
              {
                setPhase({ kind: 'idle' })
              }
            }}
            onBlur={() => setTouched(text.trim() !== '')}
          />
          <Button type="submit" variant="primary" loading={reading} loadingLabel={PLAYER_COPY.linkAdding}>{PLAYER_COPY.linkAdd}</Button>
        </div>
        <p id={messageId} className={cx('text-label', message !== null ? 'text-error' : 'text-ink-3')} role={message !== null ? 'alert' : undefined}>
          {message ?? PLAYER_COPY.linkHint}
        </p>
      </div>
      {phase.kind === 'reading' && (
        <div className="flex flex-col gap-2" role="status">
          <ProgressBar label="Reading the link" size="sm" showValue={false} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-ink-2">{lookupSentence(elapsed)}</span>
            <Button size="sm" variant="ghost" onClick={stopWaiting}>{PLAYER_COPY.linkStop}</Button>
          </div>
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className="flex flex-col gap-1 rounded-sm bg-wash-error px-3 py-2 inset-ring inset-ring-error-fill/45" role="alert">
          <p className="text-body text-ink">{phase.failure.message}</p>
          {phase.failure.detail !== null && (
            <>
              <button type="button" className="self-start text-label text-ink-2 hover:text-ink hover:underline" aria-expanded={showDetail} onClick={() => setShowDetail((value) => !value)}>
                {PLAYER_COPY.details}
              </button>
              {showDetail && <code className="font-mono text-label break-all whitespace-pre-wrap text-ink-3">{phase.failure.detail}</code>}
            </>
          )}
        </div>
      )}
      {phase.kind === 'added' && <p className="text-label text-verified" role="status">{foundSentence(phase.count)}</p>}
      {history.length > 0 && !reading && (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <h3 className="text-label font-semibold text-ink-2">{PLAYER_COPY.linkRecent}</h3>
          <ul className="flex flex-col">
            {history.slice(0, RECENT_LINKS_SHOWN).map((entry) => (
              <li key={entry.url} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex h-9 min-w-0 flex-1 flex-col items-start justify-center rounded-sm px-2 text-start hover:bg-wash-hover"
                  onClick={() =>
                  {
                    setText(entry.url)
                    void submit(entry.url)
                  }}
                >
                  <span className="w-full truncate text-body text-ink">{entry.title}</span>
                  <span className="w-full truncate text-label text-ink-3">{entry.trackCount === 1 ? '1 track' : `${entry.trackCount} tracks`} · {entry.url}</span>
                </button>
                <IconButton label={`${PLAYER_COPY.linkForget} ${entry.title}`} icon="action.remove" size="sm" onClick={() => void forget(entry.url)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  )
}

/** The Add link button and its popover. */
export function AddLinkPopover({ onAdd, triggerRef, iconOnly = false }: AddLinkProps): ReactElement
{
  const trigger = iconOnly
    ? <IconButton ref={triggerRef} label={PLAYER_COPY.addLink} icon="player.addLink" shortcut="Mod+U" />
    : <Button ref={triggerRef} icon="player.addLink">{PLAYER_COPY.addLink}</Button>
  const [session, setSession] = useState(0)
  return (
    <Popover
      label={PLAYER_COPY.linkHeading}
      trigger={trigger}
      className="w-[min(30rem,calc(100vw-2rem))]"
      onOpenChange={(open) =>
      {
        if (open)
        {
          setSession((value) => value + 1)
        }
      }}
    >
      {(close) => <LinkForm openSignal={session} onAdd={onAdd} close={close} />}
    </Popover>
  )
}
