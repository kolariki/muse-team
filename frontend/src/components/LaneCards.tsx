import { Check, Play } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import AgentAvatar from './AgentAvatar'

/**
 * The two doors of the home. Behind the copy of each card runs its own pipeline ("the circuit"), full-bleed and faded:
 *  direct: the prompt being typed → prompt engineering → the builder writing files → ready
 *  team:   the prompt → prompt engineering → the team debating (avatars taking turns) → the brief → the builder → ready
 * The nodes (HTML, so the avatars can live there) are anchored to the card's edges; the wires (SVG) are drawn from the
 * nodes' measured positions, so they line up at any card size. Pure CSS keyframes (index.css), looping; --lane-loop is the loop length.
 */
type Lane = 'direct' | 'team'
type Box = { left?: string; right?: string; top?: string; bottom?: string; w: number; h: number }

const LAYOUT: Record<Lane, Record<string, Box>> = {
  direct: { prompt: { left: '3.5%', bottom: '7%', w: 250, h: 62 }, eng: { left: '46%', bottom: '11%', w: 166, h: 62 }, build: { right: '4%', top: '18%', w: 172, h: 86 } },
  team: { prompt: { left: '3.5%', bottom: '7%', w: 232, h: 60 }, eng: { left: '42%', bottom: '9%', w: 152, h: 58 }, team: { right: '4%', top: '56%', w: 176, h: 62 }, brief: { right: '4%', top: '32%', w: 132, h: 56 }, build: { right: '4%', top: '5%', w: 148, h: 76 } },
}
const ORDER: Record<Lane, string[]> = { direct: ['prompt', 'eng', 'build'], team: ['prompt', 'eng', 'team', 'brief', 'build'] }
// when each node lights up (seconds into the loop) and the loop length
const TIMING: Record<Lane, { at: Record<string, number>; loop: number }> = {
  direct: { at: { prompt: 0, eng: 3.0, build: 5.2 }, loop: 9 },
  team: { at: { prompt: 0, eng: 3.0, team: 4.8, brief: 8.4, build: 10.0 }, loop: 14 },
}

const TEAM = [
  { name: 'CEO', role: 'ceo', provider: 'meta' },
  { name: 'CTO', role: 'cto', provider: 'meta' },
  { name: 'Diseño', role: 'product-designer', provider: 'meta' },
  { name: 'QA', role: 'qa', provider: 'meta' },
]

type R = { x: number; y: number; w: number; h: number }
/** a smooth S-curve between two measured boxes: side to side, or bottom → top when they are stacked */
function wire(a: R, b: R): string {
  const stacked = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < Math.max(a.w, b.w) * 0.7
  if (stacked) {
    const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2, y2 = b.y + b.h
    const my = (y1 + y2) / 2
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
  }
  const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

function Node({ k, box, label, at, className = '', children }: { k: string; box: Box; label: string; at: number; className?: string; children?: ReactNode }) {
  return (
    <div data-k={k} className={`lane-node ${className}`} style={{ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.w, height: box.h, animationDelay: `${at}s` }}>
      <div className="lane-node-label">{label}</div>
      {children}
    </div>
  )
}

function Scene({ lane }: { lane: Lane }) {
  const T = useT()
  const L = LAYOUT[lane]
  const { at, loop } = TIMING[lane]
  const order = ORDER[lane]
  const ref = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<string[]>([])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const base = el.getBoundingClientRect()
      const rect = (k: string): R | null => {
        const n = el.querySelector<HTMLElement>(`[data-k="${k}"]`)
        if (!n) return null
        const r = n.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
      }
      const out: string[] = []
      for (let i = 0; i < order.length - 1; i++) {
        const a = rect(order[i]), b = rect(order[i + 1])
        if (a && b) out.push(wire(a, b))
      }
      setPaths(out)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [order])
  return (
    <div ref={ref} className={`lane-scene lane-scene--${lane}`} style={{ ['--lane-loop' as string]: `${loop}s` }} aria-hidden>
      <svg className="lane-wires">
        {paths.map((d, i) => (
          <g key={i}>
            <path d={d} className="lane-wire-base" pathLength={100} />
            <path d={d} className="lane-wire-pulse" pathLength={100} style={{ animationDelay: `${at[order[i + 1]] - 1.1}s` }} />
          </g>
        ))}
      </svg>
      <Node k="prompt" box={L.prompt} label={T('Tu pedido', 'Your request')} at={at.prompt} className="lane-node--prompt">
        <div className="lane-type"><span className="lane-type-in" style={{ width: L.prompt.w - 24 }}>{T('Una app para reservar turnos en mi peluquería…', 'An app to book appointments at my salon…')}</span></div>
      </Node>
      <Node k="eng" box={L.eng} label="Prompt engineering" at={at.eng} className="lane-node--eng">
        <div className="lane-bars">{[72, 100, 58, 86].map((w, i) => <span key={w} style={{ width: `${w}%`, animationDelay: `${at.eng + 0.25 + i * 0.22}s` }} />)}</div>
      </Node>
      {lane === 'team' && (
        <>
          <Node k="team" box={L.team} label={T('El equipo debate', 'The team debates')} at={at.team} className="lane-node--team">
            <div className="lane-team">
              {TEAM.map((a, i) => (
                <span key={a.name} className="lane-avatar" style={{ animationDelay: `${at.team + 0.3 + i * 0.7}s` }}>
                  <AgentAvatar agent={a} size={24} ring={false} />
                </span>
              ))}
            </div>
          </Node>
          <Node k="brief" box={L.brief} label="Brief" at={at.brief} className="lane-node--brief">
            <div className="lane-lines">{[88, 64, 76].map((w, i) => <span key={w} style={{ width: `${w}%`, animationDelay: `${at.brief + 0.25 + i * 0.22}s` }} />)}</div>
          </Node>
        </>
      )}
      <Node k="build" box={L.build} label={T('Construcción', 'Build')} at={at.build} className="lane-node--build">
        <div className="lane-files">
          {['src/App.tsx', 'api/routes.ts', 'db/schema.sql'].map((f, i) => (
            <span key={f} style={{ animationDelay: `${at.build + 0.35 + i * 0.4}s` }}>{f}</span>
          ))}
        </div>
        <span className="lane-done" style={{ animationDelay: `${at.build + 1.9}s` }}><Check size={10} strokeWidth={3} /> {T('lista', 'ready')}</span>
      </Node>
    </div>
  )
}

function Circuit({ lane }: { lane: Lane }) {
  return (
    <div className="lane-circuit">
      <Scene lane={lane} />
      <div className="lane-veil" />
    </div>
  )
}

export default function LaneCards({ onPick }: { onPick: (lane: Lane) => void }) {
  const T = useT()
  const cards: { id: Lane; tag: string; title: string; text: string }[] = [
    { id: 'direct', tag: T('Un prompt → una app', 'One prompt → one app'), title: T('Constructor directo', 'Direct builder'), text: T('Contás qué querés, el prompt engineering lo convierte en un brief completo y el constructor arranca ya. Lo más rápido y lo más barato. El equipo queda a un clic para revisar después.', 'Say what you want, prompt engineering turns it into a full brief and the builder starts right away. Fastest and cheapest. The team is one click away to review afterwards.') },
    { id: 'team', tag: T('Debate → brief → construcción', 'Debate → brief → build'), title: T('Constructor con equipo de desarrollo', 'Builder with a development team'), text: T('CEO, CTO, Producto, Diseño y QA debaten tu idea en vivo, deciden producto, alcance y stack, y recién ahí construyen. Para cuando querés decisiones justificadas y revisión por roles.', 'CEO, CTO, Product, Design and QA debate your idea live, decide product, scope and stack, and only then build. For when you want justified decisions and role-by-role review.') },
  ]
  return (
    <div className="mt-10 grid gap-5 md:grid-cols-2">
      {cards.map((c) => (
        <div key={c.id} className="lane-ring">
        <button type="button" onClick={() => onPick(c.id)} className="lane-card group panel relative isolate flex h-full min-h-[372px] w-full flex-col items-start overflow-hidden rounded-3xl p-7 text-left transition hover:border-accent">
          <Circuit lane={c.id} />
          <div className="relative z-10 flex flex-col items-start gap-3">
            <span className="rounded-full border border-line bg-surface/90 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.2em] text-ink-3">{c.tag}</span>
            <span className="max-w-[360px] text-[26px] leading-tight">{c.title}</span>
            <span className="max-w-[330px] text-[14px] leading-relaxed text-ink-2">{c.text}</span>
          </div>
          <span className="absolute bottom-6 right-6 z-10 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition group-hover:brightness-110">{T('Elegir', 'Choose')} <Play size={13} /></span>
        </button>
        </div>
      ))}
    </div>
  )
}
