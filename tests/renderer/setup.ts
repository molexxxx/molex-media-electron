/**
 * Renderer test environment: jest-dom matchers, explicit Testing Library cleanup (it must not depend on
 * globals), and shims for the platform APIs jsdom lacks (dialog, popover, matchMedia, ResizeObserver,
 * elementFromPoint, scrollIntoView).
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() =>
{
  cleanup()
})

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal)
{
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void
  {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, value?: string): void
  {
    if (!this.hasAttribute('open')) return
    this.removeAttribute('open')
    if (value !== undefined) this.returnValue = value
    this.dispatchEvent(new Event('close'))
  }
}

if (!('showPopover' in HTMLElement.prototype))
{
  // jsdom's default stylesheet hides every [popover], and jsdom will not focus an element that is not rendered, so a
  // popover the shim shows must render as one shown by a browser does. Only an important author rule outranks it.
  const shown = document.createElement('style')
  shown.textContent = '[popover][data-popover-open] { display: block !important; }'
  document.head.append(shown)
  Object.assign(HTMLElement.prototype, {
    showPopover(this: HTMLElement): void
    {
      this.toggleAttribute('data-popover-open', true)
    },
    hidePopover(this: HTMLElement): void
    {
      this.toggleAttribute('data-popover-open', false)
    },
    togglePopover(this: HTMLElement, force?: boolean): boolean
    {
      const open = force ?? !this.hasAttribute('data-popover-open')
      this.toggleAttribute('data-popover-open', open)
      return open
    }
  })
}

if (!window.matchMedia)
{
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }) as MediaQueryList
}

if (typeof window.ResizeObserver === 'undefined')
{
  window.ResizeObserver = class
  {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

document.elementFromPoint ??= (): Element | null => null
Element.prototype.scrollIntoView ??= function (): void {}
