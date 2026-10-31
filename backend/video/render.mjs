// Renders one ad in the formats it asks for. Usage: node render.mjs <job.json>
// job: { props (without format), out: <dir>, formats: ["vertical", "square"], composition?: "Ad" | "Studio", media?: <dir>,
//        scale?: number, still?: false }
// With `media`, the files of that folder are served on a local port and every "media:<name>" string in the props points there
// (the Studio's own videos and images).
// Writes <out>/<format>.mp4 and <out>/<format>.jpg (the cover Meta shows before the video plays) and prints one JSON
// line per step on stdout ({progress}, {done}, {error}) that backend/app/ads.py reads.
import { bundle } from '@remotion/bundler'
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// the bundle is built once (in the Docker image, `npm run bundle`) and rebuilt only when the composition changed
async function serveUrl() {
  const out = path.join(here, 'build')
  const newest = (d) => readdirSync(d).reduce((m, f) => Math.max(m, statSync(path.join(d, f)).mtimeMs), 0)
  if (existsSync(path.join(out, 'index.html')) && statSync(path.join(out, 'index.html')).mtimeMs > newest(path.join(here, 'src'))) return out
  say({ step: 'bundle' })
  return bundle({ entryPoint: path.join(here, 'src', 'index.ts'), outDir: out })
}

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

/** A static server for the job's media folder, with byte ranges (the video decoder seeks). */
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').split('?')[0].slice(1))
      const file = path.join(dir, path.basename(name))
      if (!existsSync(file)) { res.writeHead(404); return res.end() }
      const size = statSync(file).size
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
      if (m) {
        const start = m[1] ? Number(m[1]) : 0
        const end = m[2] ? Number(m[2]) : size - 1
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 })
        return createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      createReadStream(file).pipe(res)
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

let server = null
try {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  if (job.media) {
    server = await serve(job.media)
    const base = `http://127.0.0.1:${server.address().port}/`
    job.props = JSON.parse(JSON.stringify(job.props).replace(/"media:([^"]+)"/g, (_, n) => JSON.stringify(base + encodeURIComponent(n))))
  }
  const id = job.composition || 'Ad'
  // a browser of this machine when the job names one (macOS: the downloaded headless shell cannot find its ICU data
  // from its child processes, so development renders with Google Chrome); otherwise Remotion's own headless shell
  const browser = job.browser ? { browserExecutable: job.browser, chromeMode: job.chromeMode || 'chrome-for-testing' } : {}
  if (!job.browser) await ensureBrowser()
  const url = await serveUrl()
  const formats = job.formats?.length ? job.formats : ['vertical', 'square']
  for (const [i, format] of formats.entries()) {
    const inputProps = { ...job.props, format }
    const composition = await selectComposition({ serveUrl: url, id, inputProps, ...browser })
    await renderMedia({
      composition, serveUrl: url, codec: 'h264', inputProps, outputLocation: path.join(job.out, `${format}.mp4`),
      crf: job.scale && job.scale < 1 ? 26 : 20, pixelFormat: 'yuv420p', concurrency: job.concurrency || null, scale: job.scale || 1, ...browser,
      onProgress: ({ progress }) => say({ format, progress: (i + progress) / formats.length }),
    })
    // the cover: the moment the hook is fully on screen
    if (job.still !== false) await renderStill({ composition, serveUrl: url, inputProps, frame: Math.min(60, composition.durationInFrames - 1), imageFormat: 'jpeg', jpegQuality: 88, ...browser, output: path.join(job.out, `${format}.jpg`) })
    say({ format, done: true, seconds: composition.durationInFrames / composition.fps })
  }
  say({ finished: true })
  server?.close()
} catch (e) {
  say({ error: String(e?.message || e).slice(0, 2000) })
  server?.close()
  process.exit(1)
}
