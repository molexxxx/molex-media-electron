// Attaches to a vitest worker started with --inspect, waits for the file to stall, then pauses the
// worker three times and prints its JavaScript stack each time, so a busy loop names itself.

const base = 'http://127.0.0.1:9229'
const settleMs = Number(process.env.STACK_PROBE_SETTLE_MS ?? 150_000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets()
{
  try
  {
    const response = await fetch(`${base}/json/list`)
    const list = await response.json()
    return list.length > 0 ? list : null
  }
  catch
  {
    return null
  }
}

let found = null
for (let attempt = 0; attempt < 180 && found === null; attempt++)
{
  found = await targets()
  if (found === null)
  {
    await sleep(1000)
  }
}
if (found === null)
{
  console.log('stack-probe: no inspector target appeared')
  process.exit(0)
}

const socket = new WebSocket(found[0].webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

function send(method, params = {})
{
  return new Promise((resolve) =>
  {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.onmessage = (event) =>
{
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id))
  {
    pending.get(message.id)(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Debugger.paused')
  {
    const frames = message.params.callFrames.slice(0, 30).map((frame) =>
      `${frame.functionName || '(anonymous)'}  ${frame.url.replace(/^file:\/\/\//, '')}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1}`)
    console.log(`--- paused ${new Date().toISOString()}\n${frames.join('\n')}`)
    void send('Debugger.resume')
  }
}

await new Promise((resolve) => { socket.onopen = resolve })
await send('Debugger.enable')
console.log(`stack-probe: attached to ${found[0].webSocketDebuggerUrl}, pausing in ${settleMs / 1000} s`)
await sleep(settleMs)
for (let round = 0; round < 3; round++)
{
  await send('Debugger.pause')
  await sleep(10_000)
}
socket.close()
