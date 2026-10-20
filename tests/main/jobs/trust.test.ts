import { describe, expect, it } from 'vitest'
import { isTrustedSender, rendererLocationFrom, type RendererLocation } from '../../../src/main/jobs/trust'

const DEV: RendererLocation = { kind: 'dev', origin: 'http://localhost:5173' }
const INDEX = 'file:///C:/Program%20Files/molexMedia/resources/app.asar/out/renderer/index.html'
const PACKAGED: RendererLocation = { kind: 'file', url: INDEX }
const RENDERER = 'file:///C:/Program%20Files/molexMedia/resources/app.asar/out/renderer'

describe('isTrustedSender in development', () =>
{
  it.each([
    'http://localhost:5173',
    'http://localhost:5173/',
    'http://localhost:5173/index.html',
    'http://localhost:5173/nested/page?x=1',
    'http://localhost:5173/#popout'
  ])('trusts the dev origin and its paths: %s', (url) =>
  {
    expect(isTrustedSender(url, true, DEV)).toBe(true)
  })

  it.each([
    'http://localhost:5174/',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'http://localhost:51730/',
    'http://localhost:5173.evil.test/',
    'http://evil.test/?from=http://localhost:5173/',
    'http://user@evil.test/localhost:5173',
    `${INDEX}`,
    'not a url'
  ])('refuses another origin: %s', (url) =>
  {
    expect(isTrustedSender(url, true, DEV)).toBe(false)
  })

  it('compares the expected value by origin, so a path in it does not matter', () =>
  {
    const withPath: RendererLocation = { kind: 'dev', origin: 'http://localhost:5173/some/page' }
    expect(isTrustedSender('http://localhost:5173/', true, withPath)).toBe(true)
    expect(isTrustedSender('http://localhost:5174/', true, withPath)).toBe(false)
  })

  it('trusts nothing when the expected origin is not a web origin', () =>
  {
    expect(isTrustedSender('http://localhost:5173/', true, { kind: 'dev', origin: 'not a url' })).toBe(false)
    expect(isTrustedSender('file:///C:/app/index.html', true, { kind: 'dev', origin: 'file:///C:/app/index.html' })).toBe(false)
  })
})

describe('isTrustedSender when packaged', () =>
{
  it('trusts the packaged index.html', () =>
  {
    expect(isTrustedSender(INDEX, true, PACKAGED)).toBe(true)
  })

  it('trusts the popout fragment and query strings', () =>
  {
    expect(isTrustedSender(`${INDEX}#popout`, true, PACKAGED)).toBe(true)
    expect(isTrustedSender(`${INDEX}?view=batch`, true, PACKAGED)).toBe(true)
    expect(isTrustedSender(`${INDEX}?view=batch#popout`, true, PACKAGED)).toBe(true)
  })

  it('folds only the Windows drive letter case', () =>
  {
    const lower = 'file:///c:/Program%20Files/molexMedia/resources/app.asar/out/renderer/index.html'
    expect(isTrustedSender(lower, true, PACKAGED)).toBe(true)
    expect(isTrustedSender(INDEX, true, { kind: 'file', url: lower })).toBe(true)
    expect(isTrustedSender('file:///C:/program%20files/molexMedia/resources/app.asar/out/renderer/index.html', true, PACKAGED)).toBe(false)
  })

  it.each([
    'file:///C:/Users/me/Downloads/index.html',
    `${RENDERER}/other.html`,
    'file:///D:/Program%20Files/molexMedia/resources/app.asar/out/renderer/index.html',
    'file://server/C:/Program%20Files/molexMedia/resources/app.asar/out/renderer/index.html'
  ])('refuses another local file: %s', (url) =>
  {
    expect(isTrustedSender(url, true, PACKAGED)).toBe(false)
  })

  it.each([
    'file://',
    'file:///',
    'file:///C:/Program%20Files/molexMedia/',
    `${RENDERER}/`,
    `${INDEX}.evil.html`,
    `${INDEX}x`,
    `${INDEX}/child.html`
  ])('refuses a file URL that only shares a prefix: %s', (url) =>
  {
    expect(isTrustedSender(url, true, PACKAGED)).toBe(false)
  })

  it('resolves encoded dot segments before comparing', () =>
  {
    expect(isTrustedSender(`${RENDERER}/%2e%2e/evil/index.html`, true, PACKAGED)).toBe(false)
    expect(isTrustedSender(`${RENDERER}/%2E%2E/%2E%2E/%2E%2E/index.html`, true, PACKAGED)).toBe(false)
    expect(isTrustedSender(`${RENDERER}/%2e%2e%2fevil.html`, true, PACKAGED)).toBe(false)
    expect(isTrustedSender(`${RENDERER}%2Findex.html`, true, PACKAGED)).toBe(false)
    expect(isTrustedSender(`${RENDERER}/%2e%2e/renderer/index.html`, true, PACKAGED)).toBe(true)
  })

  it.each([
    'http://localhost/C:/Program%20Files/molexMedia/resources/app.asar/out/renderer/index.html',
    'app://renderer/index.html',
    'not a url'
  ])('refuses another scheme or a malformed URL: %s', (url) =>
  {
    expect(isTrustedSender(url, true, PACKAGED)).toBe(false)
  })

  it('compares POSIX file URLs exactly', () =>
  {
    const posix: RendererLocation = { kind: 'file', url: 'file:///opt/molexMedia/resources/app.asar/out/renderer/index.html' }
    expect(isTrustedSender('file:///opt/molexMedia/resources/app.asar/out/renderer/index.html#popout', true, posix)).toBe(true)
    expect(isTrustedSender('file:///opt/molexmedia/resources/app.asar/out/renderer/index.html', true, posix)).toBe(false)
  })

  it('trusts nothing when the expected value is not a file URL', () =>
  {
    expect(isTrustedSender('http://localhost:5173/', true, { kind: 'file', url: 'http://localhost:5173/' })).toBe(false)
    expect(isTrustedSender(INDEX, true, { kind: 'file', url: 'nope' })).toBe(false)
  })
})

describe('isTrustedSender frames', () =>
{
  it('refuses a subframe of the trusted page', () =>
  {
    expect(isTrustedSender(INDEX, false, PACKAGED)).toBe(false)
    expect(isTrustedSender('http://localhost:5173/', false, DEV)).toBe(false)
  })

  it('refuses a null frame', () =>
  {
    expect(isTrustedSender(null, false, PACKAGED)).toBe(false)
    expect(isTrustedSender(null, true, PACKAGED)).toBe(false)
    expect(isTrustedSender(null, true, DEV)).toBe(false)
  })
})

describe('rendererLocationFrom', () =>
{
  it('uses the dev server when its URL is set', () =>
  {
    expect(rendererLocationFrom('http://localhost:5173', INDEX)).toEqual({ kind: 'dev', origin: 'http://localhost:5173' })
  })

  it.each([undefined, null, ''])('uses the packaged file otherwise (%s)', (dev) =>
  {
    expect(rendererLocationFrom(dev, INDEX)).toEqual({ kind: 'file', url: INDEX })
  })
})
