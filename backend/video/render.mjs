// Renders one ad in the formats it asks for. Usage: node render.mjs <job.json>
// job: { props: AdProps (without format), out: <dir>, formats: ["vertical", "square"] }
// Writes <out>/<format>.mp4 and <out>/<format>.jpg (the cover Meta shows before the video plays) and prints one JSON
// line per step on stdout ({progress}, {done}, {error}) that backend/app/ads.py reads.
import { bundle } from '@remotion/bundler'
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

try {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  // a browser of this machine when the job names one (macOS: the downloaded headless shell cannot find its ICU data
  // from its child processes, so development renders with Google Chrome); otherwise Remotion's own headless shell
  const browser = job.browser ? { browserExecutable: job.browser, chromeMode: job.chromeMode || 'chrome-for-testing' } : {}
  if (!job.browser) await ensureBrowser()
  const url = await serveUrl()
  const formats = job.formats?.length ? job.formats : ['vertical', 'square']
  for (const [i, format] of formats.entries()) {
    const inputProps = { ...job.props, format }
    const composition = await selectComposition({ serveUrl: url, id: 'Ad', inputProps, ...browser })
    await renderMedia({
      composition, serveUrl: url, codec: 'h264', inputProps, outputLocation: path.join(job.out, `${format}.mp4`),
      crf: 20, pixelFormat: 'yuv420p', concurrency: job.concurrency || null, ...browser,
      onProgress: ({ progress }) => say({ format, progress: (i + progress) / formats.length }),
    })
    // the cover: the moment the hook is fully on screen
    await renderStill({ composition, serveUrl: url, inputProps, frame: 60, imageFormat: 'jpeg', jpegQuality: 88, ...browser, output: path.join(job.out, `${format}.jpg`) })
    say({ format, done: true, seconds: composition.durationInFrames / composition.fps })
  }
  say({ finished: true })
} catch (e) {
  say({ error: String(e?.message || e).slice(0, 2000) })
  process.exit(1)
}
