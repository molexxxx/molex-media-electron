/**
 * Which frames may send job commands: only the app's own renderer, in its main frame. Main never trusts the
 * preload as an allowlist; every handler checks the sending frame here first.
 */

/** Where the app's renderer is loaded from: the dev server in development, the packaged index.html otherwise. */
export type RendererLocation =
  | { kind: 'dev'; origin: string }
  | { kind: 'file'; url: string }

/** The location to trust: the dev server when its URL is set, else the packaged index.html file URL. */
export function rendererLocationFrom(devServerUrl: string | null | undefined, indexFileUrl: string): RendererLocation
{
  if (devServerUrl)
  {
    return { kind: 'dev', origin: devServerUrl }
  }
  return { kind: 'file', url: indexFileUrl }
}

function parse(text: string): URL | null
{
  try
  {
    return new URL(text)
  }
  catch
  {
    return null
  }
}

function webOrigin(text: string): string | null
{
  const url = parse(text)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
  {
    return null
  }
  return url.origin
}

function fileKey(text: string): string | null
{
  const url = parse(text)
  if (!url || url.protocol !== 'file:')
  {
    return null
  }
  const path = url.pathname.replace(/^\/([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}:`)
  return `file://${url.host}${path}`
}

/**
 * Whether a command came from the app's renderer: the frame exists, is a main frame, and its URL without hash and
 * query is the dev server's origin or exactly the packaged index.html, so the popout's `#popout` passes and any other
 * page, local file, or origin fails.
 */
export function isTrustedSender(frameUrl: string | null, isMainFrame: boolean, expected: RendererLocation): boolean
{
  if (frameUrl === null || !isMainFrame)
  {
    return false
  }
  if (expected.kind === 'dev')
  {
    const origin = webOrigin(expected.origin)
    return origin !== null && webOrigin(frameUrl) === origin
  }
  const want = fileKey(expected.url)
  return want !== null && fileKey(frameUrl) === want
}
