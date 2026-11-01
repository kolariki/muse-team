// A recorded walk through a web app, for ads: a phone-sized headless Chrome opens the page, scrolls it slowly, then visits a
// few pages from its menu. Every frame is a screenshot (so scrolling is smooth whatever the machine), written as JPEGs that
// the backend turns into a 1080×1920 video with ffmpeg.
//   node tour.mjs job.json   job: {url, out (folder), seconds, browser?, fps?}
// Prints JSON lines: {step}, {pages}, {done, frames}, {error}.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const W = 432, H = 768, DPR = 2.5, FPS = job.fps || 30
const total = Math.max(8, Math.min(60, job.seconds || 24)) * FPS
mkdirSync(job.out, { recursive: true })

function findShell(dir, depth = 0) {
  if (!existsSync(dir) || depth > 4) return null
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (n === 'chrome-headless-shell' && statSync(p).isFile()) return p
    if (statSync(p).isDirectory()) { const f = findShell(p, depth + 1); if (f) return f }
  }
  return null
}

async function browserPath() {
  if (job.browser) return job.browser
  const here = join(process.cwd(), 'node_modules', '.remotion')
  let p = findShell(here)
  if (!p) { const { ensureBrowser } = await import('@remotion/renderer'); await ensureBrowser(); p = findShell(here) }
  if (!p) throw new Error('No hay un Chrome sin pantalla en el servidor')
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let chrome
async function main() {
  const exe = await browserPath()
  chrome = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--disable-dev-shm-usage', `--user-data-dir=${join(job.out, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error('Chrome no arrancó')), 20000)
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]) } })
    chrome.on('exit', () => rej(new Error('Chrome se cerró al arrancar')))
  })
  const port = new URL(wsUrl).port
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const WS = globalThis.WebSocket || (await import('ws')).default // (Node < 22 has no WebSocket of its own)
  const ws = new WS(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('No pude hablar con Chrome')) })
  let id = 0
  const wait = new Map(), events = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && wait.has(d.id)) { const [ok, ko] = wait.get(d.id); wait.delete(d.id); d.error ? ko(new Error(d.error.message)) : ok(d.result) }
    else if (d.method) events.push(d.method)
  }
  const cdp = (method, params = {}) => new Promise((ok, ko) => { const i = ++id; wait.set(i, [ok, ko]); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true })
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true })

  async function open(url) {
    events.length = 0
    await cdp('Page.navigate', { url })
    for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(150)
    await sleep(1800) // fonts, hero animations, lazy images
    await js(`(() => { document.documentElement.style.scrollBehavior = 'auto'; document.body && (document.body.style.scrollBehavior = 'auto');
      // cookie/consent banners and chat bubbles out of the shot
      for (const el of document.querySelectorAll('[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=intercom i],[class*=crisp i],iframe[title*=chat i]')) {
        const r = el.getBoundingClientRect(); if (r.height < innerHeight * 0.6) el.style.setProperty('display', 'none', 'important') }
      return true })()`)
  }

  say({ step: 'Abriendo la página' })
  await open(job.url)
  const home = await js('location.href')
  // the menu's pages (same site, no anchors or sign-in/out), in menu order
  const links = await js(`(() => { const seen = new Set([location.pathname]); const out = [];
    const all = [...document.querySelectorAll('header a[href], nav a[href], [role=navigation] a[href]'), ...document.querySelectorAll('a[href]')];
    for (const a of all) { let u; try { u = new URL(a.href) } catch { continue }
      if (u.origin !== location.origin || seen.has(u.pathname) || /\\.(pdf|png|jpe?g|zip)$/i.test(u.pathname) || /log ?out|sign ?out|salir|cerrar sesi/i.test(a.textContent + u.pathname)) continue;
      seen.add(u.pathname); out.push(u.href); if (out.length >= 3) break }
    return out })()`)
  const pages = [home, ...links].slice(0, links.length ? 3 : 1)
  say({ pages })

  let frame = 0
  const shot = async () => {
    const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82, fromSurface: true })
    writeFileSync(join(job.out, `f${String(frame++).padStart(5, '0')}.jpg`), Buffer.from(r.data, 'base64'))
  }
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  // the time goes mostly to the first page (the one people land on)
  const shares = pages.length === 1 ? [1] : pages.length === 2 ? [0.6, 0.4] : [0.5, 0.25, 0.25]
  for (let p = 0; p < pages.length; p++) {
    if (p > 0) { say({ step: `Abriendo ${new URL(pages[p]).pathname}` }); await open(pages[p]) }
    say({ step: p === 0 ? 'Grabando la página principal' : `Grabando ${new URL(pages[p]).pathname}` })
    const n = Math.round(total * shares[p])
    // what scrolls: the page, or (apps with a fixed shell) the biggest scrollable box inside it
    const dist = await js(`(() => { const root = document.scrollingElement || document.documentElement; let best = root, room = root.scrollHeight - innerHeight;
      if (room < 50) for (const el of document.querySelectorAll('body *')) { const st = getComputedStyle(el);
        if (!/(auto|scroll)/.test(st.overflowY) || el.clientHeight < innerHeight * 0.5) continue;
        const r = el.scrollHeight - el.clientHeight; if (r > room) { room = r; best = el } }
      window.__tour = best; return Math.max(0, Math.min(room, ${H * 5})) })()`)
    const hold = Math.round(FPS * 1.2)
    for (let i = 0; i < n; i++) {
      const t = i < hold ? 0 : (i - hold) / Math.max(1, n - hold - Math.round(FPS * 0.6))
      await js(`window.__tour.scrollTop = ${Math.round(ease(Math.min(1, t)) * dist)}`)
      await shot()
    }
  }
  say({ done: true, frames: frame, fps: FPS })
}

main().catch((e) => say({ error: String(e && e.message || e) })).finally(() => { try { chrome && chrome.kill('SIGKILL') } catch {} ; process.exit(0) })
