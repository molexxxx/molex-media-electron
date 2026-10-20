/**
 * The toolbar's search field. It filters as the user types, 150 ms after the last key; Escape clears it and a
 * second Escape leaves it; the clear button empties it. Collapsed, it is an icon button that expands the field
 * over the toolbar, and the field folds back into the button when focus leaves it.
 */
import React, { useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { cx, Icon, IconButton } from '../../../ui'

/** How long typing rests before the search applies. */
export const SEARCH_DEBOUNCE_MS = 150

/** The placeholder in Queue, Review, and Run. */
export const SEARCH_PLACEHOLDER = 'Filter by name or folder'

/** The placeholder in History, which searches every kept batch. */
export const HISTORY_SEARCH_PLACEHOLDER = 'Find a file or job number'

/** The clear button's name. */
export const CLEAR_SEARCH_LABEL = 'Clear search'

/** The collapsed field's button name. */
export const SEARCH_BUTTON_LABEL = 'Search'

/** The description a search that keeps no rows adds to the field. */
export const NO_MATCHES_TEXT = 'Nothing matches this search.'

/** What the toolbar's shortcuts call. */
export interface SearchFieldHandle
{
  /** Focuses the field, expanding it first when collapsed. */
  focus(): void
  /** Applies a pending search at once. */
  flush(): void
}

/** Props of SearchField. */
export interface SearchFieldProps
{
  /** The search the list applies. */
  value: string
  /** Applies a search: 150 ms after the last key, or at once for Clear, Escape, and leaving the field. */
  onSearch(value: string): void
  placeholder?: string
  /** The field's accessible name; the placeholder when omitted. */
  label?: string
  /** True while the applied search keeps no rows. */
  noMatches?: boolean
  /** Shows an icon button that expands the field over the toolbar. */
  collapsed?: boolean
  /** Where a second Escape sends focus; without it the field only lets go of focus. */
  onLeave?(): void
  id?: string
  className?: string
  ref?: React.Ref<SearchFieldHandle>
}

/** A search box with a clear button, debounced, optionally collapsed into an icon button. */
export function SearchField({
  value,
  onSearch,
  placeholder = SEARCH_PLACEHOLDER,
  label,
  noMatches = false,
  collapsed = false,
  onLeave,
  id,
  className,
  ref
}: SearchFieldProps): React.JSX.Element
{
  const generated = useId()
  const inputId = id ?? `search-${generated.replace(/:/g, '')}`
  const descriptionId = `${inputId}-matches`
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sent = useRef(value)
  const pending = useRef<string | null>(null)
  const latest = useRef(onSearch)
  latest.current = onSearch
  const [draft, setDraft] = useState(value)
  const [expanded, setExpanded] = useState(false)
  const [focusRequest, setFocusRequest] = useState<{ target: 'input' | 'button'; n: number }>({ target: 'input', n: 0 })
  const requestFocus = (target: 'input' | 'button'): void => setFocusRequest((request) => ({ target, n: request.n + 1 }))

  useEffect(() =>
  {
    if (value !== sent.current)
    {
      sent.current = value
      pending.current = null
      if (timer.current !== null)
      {
        clearTimeout(timer.current)
        timer.current = null
      }
      setDraft(value)
    }
  }, [value])

  useEffect(() => () =>
  {
    if (timer.current !== null)
    {
      clearTimeout(timer.current)
    }
    if (pending.current !== null)
    {
      latest.current(pending.current)
    }
  }, [])

  useEffect(() =>
  {
    if (focusRequest.n > 0)
    {
      (focusRequest.target === 'input' ? inputRef.current : buttonRef.current)?.focus()
    }
  }, [focusRequest])

  const send = (text: string): void =>
  {
    if (timer.current !== null)
    {
      clearTimeout(timer.current)
      timer.current = null
    }
    pending.current = null
    if (text !== sent.current)
    {
      sent.current = text
      latest.current(text)
    }
  }

  const flush = (): void =>
  {
    if (pending.current !== null)
    {
      send(pending.current)
    }
  }

  useImperativeHandle(ref, () => ({
    focus: () =>
    {
      if (collapsed && !expanded)
      {
        setExpanded(true)
        requestFocus('input')
        return
      }
      inputRef.current?.focus()
    },
    flush
  }))

  const change = (text: string): void =>
  {
    setDraft(text)
    pending.current = text
    if (timer.current !== null)
    {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(() =>
    {
      timer.current = null
      if (pending.current !== null)
      {
        send(pending.current)
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  const clear = (): void =>
  {
    setDraft('')
    send('')
    inputRef.current?.focus()
  }

  const leave = (): void =>
  {
    flush()
    if (collapsed)
    {
      setExpanded(false)
      if (onLeave === undefined)
      {
        requestFocus('button')
        return
      }
    }
    if (onLeave !== undefined)
    {
      onLeave()
      return
    }
    inputRef.current?.blur()
  }

  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>): void =>
  {
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)
    {
      event.preventDefault()
      event.stopPropagation()
      if (draft !== '')
      {
        setDraft('')
        send('')
        return
      }
      leave()
      return
    }
    if (event.key === 'Enter')
    {
      flush()
    }
  }

  const blur = (event: React.FocusEvent<HTMLDivElement>): void =>
  {
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
    {
      return
    }
    flush()
    if (collapsed)
    {
      setExpanded(false)
    }
  }

  const open = !collapsed || expanded
  const filtering = value.trim() !== ''

  return (
    <div className={cx('flex shrink-0 items-center', className)} data-collapsed={collapsed ? '' : undefined}>
      {collapsed && !expanded
        ? (
          <IconButton
            ref={buttonRef}
            icon="action.search"
            label={SEARCH_BUTTON_LABEL}
            className={cx(filtering && 'text-mark')}
            aria-describedby={filtering ? descriptionId : undefined}
            onClick={() =>
            {
              setExpanded(true)
              requestFocus('input')
            }}
          />
          )
        : null}
      {open
        ? (
          <div
            role="search"
            onBlur={blur}
            data-expanded={collapsed ? '' : undefined}
            className={cx(
              'flex h-8 items-center',
              collapsed ? 'absolute inset-x-4 top-1.5 z-10' : 'relative w-55 @max-[1179px]:w-40'
            )}
          >
            <Icon name="action.search" size="md" className="pointer-events-none absolute left-2 text-ink-3" />
            <input
              ref={inputRef}
              id={inputId}
              type="search"
              value={draft}
              placeholder={placeholder}
              aria-label={label ?? placeholder}
              aria-describedby={noMatches && filtering ? descriptionId : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => change(event.target.value)}
              onKeyDown={keyDown}
              className={cx(
                'h-full w-full min-w-0 rounded-sm border border-line-strong bg-sunken pr-8 pl-8 text-control text-ink placeholder:text-ink-3',
                '[&::-webkit-search-cancel-button]:appearance-none'
              )}
            />
            {draft !== ''
              ? <IconButton icon="action.close" label={CLEAR_SEARCH_LABEL} size="sm" className="absolute right-1" onClick={clear} />
              : null}
          </div>
          )
        : null}
      <span id={descriptionId} hidden>
        {noMatches && filtering ? NO_MATCHES_TEXT : `Filtering by ${value.trim()}`}
      </span>
    </div>
  )
}
