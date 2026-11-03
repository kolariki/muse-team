import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { create } from 'zustand'
import { tr, useT } from '../lib/i18n'
import { fmtK, fmtMs, fmtUsd, STANCE } from '../lib/parse'
import { agentMap, useAgentColor, useArena } from '../store'
import type { Stance } from '../types'
import Hint from './Hint'

/* ------------------------------------------------------------------ shared: one agent in the spotlight across the four cards
 * Hovering a name in any card highlights that agent everywhere; clicking pins it (click again to release). */
const useSpot = create<{ hover: string | null; pin: string | null; set: (p: Partial<{ hover: string | null; pin: string | null }>) => void }>((set) => ({ hover: null, pin: null, set: (p) => set(p) }))
const useSpotlight = () => {
  const hover = useSpot((s) => s.hover)
  const pin = useSpot((s) => s.pin)
  const set = useSpot((s) => s.set)
  const active = pin ?? hover
  return {
    active,
    pin,
    dim: (id: string) => (active && active !== id ? 0.3 : 1),
    bind: (id: string) => ({
      onMouseEnter: () => set({ hover: id }),
      onMouseLeave: () => set({ hover: null }),
      onClick: () => set({ pin: pin === id ? null : id }),
    }),
  }
}

/** Axis labels: keep names on one line ("Security Engineer" → "Security En…"). */
const short = (s: string, n = 11) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const stanceLabel = (s: Stance) => (s === 'agree' ? tr('acuerdo', 'agreement') : s === 'disagree' ? tr('desacuerdo', 'disagreement') : s === 'propose' ? tr('propuesta', 'proposal') : 'neutral')

function useAgg() {
  const config = useArena((s) => s.config)
  const turns = useArena((s) => s.turns)
  const handoffs = useArena((s) => s.handoffs)
  const colorOf = useAgentColor()
  return useMemo(() => {
    const agents = config?.agents ?? []
    const rows = agents.map((a) => {
      const mine = turns.filter((t) => t.agent_id === a.id)
      const n = mine.length || 1
      const withTtft = mine.filter((t) => t.metrics.ttft_ms != null)
      const lat = mine.map((t) => t.metrics.latency_ms)
      const conf = mine.map((t) => t.confidence).filter((c): c is number => c != null)
      return {
        id: a.id,
        name: a.name,
        color: colorOf(a),
        turns: mine.length,
        latency: Math.round(lat.reduce((x, y) => x + y, 0) / n),
        latMin: lat.length ? Math.min(...lat) : 0,
        latMax: lat.length ? Math.max(...lat) : 0,
        ttft: withTtft.length ? Math.round(withTtft.reduce((x, t) => x + (t.metrics.ttft_ms ?? 0), 0) / withTtft.length) : null,
        tps: Math.round(mine.reduce((x, t) => x + t.metrics.tokens_per_s, 0) / n),
        tokens: mine.reduce((x, t) => x + t.metrics.output_tokens, 0),
        perTurn: Math.round(mine.reduce((x, t) => x + t.metrics.output_tokens, 0) / n),
        reasoning: mine.reduce((x, t) => x + (t.metrics.reasoning_tokens || 0), 0),
        cost: mine.reduce((x, t) => x + t.metrics.cost_usd, 0),
        calledBy: handoffs.filter((h) => h.to === a.id).length,
        confAvg: conf.length ? Math.round(conf.reduce((x, y) => x + y, 0) / conf.length) : null,
        confN: conf.length,
      }
    })
    const confSeries = turns.map((t) => ({ turn: t.turn, [t.agent_id]: t.confidence }))
    return { agents, rows, confSeries, turns: turns.length }
  }, [config, turns, handoffs])
}

/** Wall clock in event-time: during a replay, event timestamps are in the past, so we track the
 * latest event ts plus time elapsed since it arrived. */
function useNow(running: boolean) {
  const lastTs = useArena((s) => s.lastEventTs)
  const [, tick] = useState(0)
  const arrived = useRef({ ts: lastTs, at: Date.now() })
  if (arrived.current.ts !== lastTs) arrived.current = { ts: lastTs, at: Date.now() }
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => tick((x) => x + 1), 250)
    return () => clearInterval(id)
  }, [running])
  const speed = useArena.getState().source === 'replay' ? useArena.getState().speed : 1
  return (lastTs ?? Date.now() / 1000) + (running ? Math.min(5, ((Date.now() - arrived.current.at) / 1000) * speed) : 0)
}

export function StatTiles() {
  const T = useT()
  const turns = useArena((s) => s.turns)
  const startedAt = useArena((s) => s.startedAt)
  const endedAt = useArena((s) => s.endedAt)
  const cost = turns.reduce((x, t) => x + t.metrics.cost_usd, 0)
  const tokens = turns.reduce((x, t) => x + t.metrics.input_tokens + t.metrics.output_tokens, 0)
  const dis = turns.length ? Math.round((100 * turns.filter((t) => t.stance === 'disagree').length) / turns.length) : 0
  const now = useNow(!endedAt && !!startedAt)
  const elapsed = startedAt ? ((endedAt ?? now) - startedAt) * 1000 : 0
  const tiles = [
    [T('Turnos', 'Turns'), `${turns.length}`],
    [T('Tokens', 'Tokens'), fmtK(tokens)],
    [T('Costo', 'Cost'), fmtUsd(cost)],
    [T('Desacuerdo', 'Disagreement'), `${dis}%`],
    [T('Duración', 'Duration'), fmtMs(elapsed)],
  ]
  return (
    <div className="grid grid-cols-5 gap-1 sm:gap-2">
      {tiles.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border border-line bg-surface px-1 py-1.5 text-center sm:rounded-xl sm:px-2 sm:py-2.5">
          <div className="w-full truncate text-[9px] text-ink-3 sm:text-[10px] sm:uppercase sm:tracking-widest">{k}</div>
          <motion.div key={v} initial={{ opacity: 0.4, y: 3 }} animate={{ opacity: 1, y: 0 }} className={`mt-0.5 w-full truncate whitespace-nowrap font-mono font-bold tabular-nums text-ink ${String(v).length > 7 ? 'text-[11px] sm:text-base' : String(v).length > 4 ? 'text-[13px] sm:text-xl' : 'text-base sm:text-xl'}`} title={String(v)}>{v}</motion.div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ building blocks */

/** Floating tooltip that follows the pointer (portal, so the cards' overflow never clips it). */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; node: ReactNode } | null>(null)
  const show = (e: React.MouseEvent, node: ReactNode) => setTip({ x: e.clientX, y: e.clientY, node })
  const move = (e: React.MouseEvent) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
  const hide = () => setTip(null)
  const el = tip
    ? createPortal(
        <div
          role="tooltip"
          className="pointer-events-none z-[300] max-w-[260px] rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-snug text-ink shadow-[0_8px_24px_-10px_rgba(30,38,34,.35)]"
          style={{ position: 'fixed', left: Math.min(tip.x + 14, window.innerWidth - 280), top: Math.min(tip.y + 14, window.innerHeight - 120) }}
        >
          {tip.node}
        </div>,
        document.body,
      )
    : null
  return { show, move, hide, el, bind: (node: () => ReactNode) => ({ onMouseEnter: (e: React.MouseEvent) => show(e, node()), onMouseMove: move, onMouseLeave: hide }) }
}

function ChartCard({ title, hint, help, right, children, footer }: { title: string; hint?: string; help?: string; right?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-widest text-ink-3">{title} {help && <Hint text={help} />}</div>
        {hint && <div className="truncate text-[10px] text-ink-4">{hint}</div>}
        {right && <div className="ml-auto shrink-0">{right}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {footer && <div className="mt-1.5 shrink-0 truncate text-[10.5px] text-ink-3">{footer}</div>}
    </div>
  )
}

/** Segmented control for a card's metric toggle. */
function Seg<K extends string>({ value, onChange, options }: { value: K; onChange: (k: K) => void; options: { key: K; label: string }[] }) {
  return (
    <div className="flex rounded-md border border-line bg-paper p-[2px] text-[10px] leading-none">
      {options.map((o) => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} className={`rounded px-1.5 py-[3px] font-semibold transition ${value === o.key ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}>{o.label}</button>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-3 text-center text-[11.5px] leading-snug text-ink-4">{text}</div>
}

/** Horizontal bars, one per agent: name on the left, thin bar in the agent's colour, value on the right, a dashed mean line. */
function Bars({ rows, value, fmt, mean, best, tip, valueWidth = 46 }: { rows: { id: string; name: string; color: string }[]; value: (r: any) => number; fmt: (v: number) => string; mean?: boolean; best?: 'min' | 'max'; tip: (r: any) => ReactNode; valueWidth?: number }) {
  const spot = useSpotlight()
  const t = useTip()
  const vals = rows.map(value)
  const max = Math.max(1, ...vals)
  const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0
  const bestVal = best === 'min' ? Math.min(...vals.filter((v) => v > 0)) : Math.max(...vals)
  return (
    <div className="flex h-full flex-col justify-around">
      {t.el}
      {rows.map((r, i) => {
        const v = vals[i]
        const isBest = best && rows.length > 1 && v === bestVal && v > 0
        return (
          <div key={r.id} className="flex cursor-default items-center gap-2 transition-opacity" style={{ opacity: spot.dim(r.id) }} {...spot.bind(r.id)} {...t.bind(() => tip(r))}>
            <div className="flex w-[74px] shrink-0 items-center gap-1.5 text-[11px] text-ink-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="truncate" title={r.name}>{short(r.name, 12)}</span>
            </div>
            <div className="relative h-[10px] flex-1 rounded-sm bg-paper">
              <motion.div className="absolute inset-y-0 left-0 rounded-sm" style={{ background: r.color }} initial={{ width: 0 }} animate={{ width: `${(100 * v) / max}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
              {mean && avg > 0 && <div className="absolute -inset-y-[3px] w-0 border-l border-dashed border-ink-3/60" style={{ left: `${(100 * avg) / max}%` }} />}
            </div>
            <div className="shrink-0 whitespace-nowrap text-right font-mono text-[10.5px] tabular-nums text-ink-2" style={{ width: valueWidth }}>{v ? fmt(v) : '—'}</div>
            <span className={`w-2 shrink-0 text-[9px] ${isBest ? 'text-accent' : 'text-transparent'}`} title={isBest ? tr('mejor', 'best') : undefined}>★</span>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ cards */

export function LatencyChart() {
  const T = useT()
  const { rows, turns } = useAgg()
  const [k, setK] = useState<'latency' | 'ttft' | 'tps'>('latency')
  const fmt = k === 'tps' ? (v: number) => `${v} t/s` : fmtMs
  const fastest = rows.length > 1 ? [...rows].sort((a, b) => a.latency - b.latency)[0] : null
  const slowest = rows.length > 1 ? [...rows].sort((a, b) => b.latency - a.latency)[0] : null
  return (
    <ChartCard
      title={T('Velocidad', 'Speed')}
      hint={k === 'latency' ? T('respuesta completa, promedio', 'full answer, average') : k === 'ttft' ? T('hasta la primera palabra', 'until the first word') : T('tokens por segundo', 'tokens per second')}
      help={T('Cuánto tarda cada modelo en contestar. Latencia: tiempo total de la respuesta. 1er token: cuánto esperás hasta que empieza a escribir. Tokens/s: velocidad de escritura. La línea punteada es el promedio del equipo; ★ marca al mejor.', 'How long each model takes to answer. Latency: total answer time. 1st token: how long until it starts writing. Tokens/s: writing speed. The dashed line is the team average; ★ marks the best.')}
      right={<Seg value={k} onChange={setK} options={[{ key: 'latency', label: T('latencia', 'latency') }, { key: 'ttft', label: T('1er token', '1st token') }, { key: 'tps', label: 'tok/s' }]} />}
      footer={fastest && slowest && fastest.id !== slowest.id && turns > 0 ? `${T('Más rápido', 'Fastest')}: ${fastest.name} (${fmtMs(fastest.latency)}) · ${T('más lento', 'slowest')}: ${slowest.name} (${fmtMs(slowest.latency)})` : undefined}
    >
      {turns === 0 ? <Empty text={T('Esperando el primer turno para medir.', 'Waiting for the first turn to measure.')} /> : (
        <Bars
          rows={rows}
          value={(r) => (k === 'latency' ? r.latency : k === 'ttft' ? r.ttft ?? 0 : r.tps)}
          fmt={fmt}
          mean
          best={k === 'tps' ? 'max' : 'min'}
          tip={(r) => (
            <div>
              <div className="font-semibold" style={{ color: r.color }}>{r.name} <span className="font-normal text-ink-3">· {r.turns} {r.turns === 1 ? T('turno', 'turn') : T('turnos', 'turns')}</span></div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
                <span className="text-ink-3">{T('latencia', 'latency')}</span><span>{fmtMs(r.latency)} <span className="text-ink-4">({fmtMs(r.latMin)}–{fmtMs(r.latMax)})</span></span>
                <span className="text-ink-3">{T('1er token', '1st token')}</span><span>{r.ttft != null ? fmtMs(r.ttft) : '—'}</span>
                <span className="text-ink-3">tok/s</span><span>{r.tps}</span>
              </div>
            </div>
          )}
        />
      )}
    </ChartCard>
  )
}

export function TokensChart() {
  const T = useT()
  const { rows, turns } = useAgg()
  const [k, setK] = useState<'tokens' | 'perTurn'>('tokens')
  const total = rows.reduce((x, r) => x + r.tokens, 0)
  const top = rows.length > 1 && total ? [...rows].sort((a, b) => b.tokens - a.tokens)[0] : null
  return (
    <ChartCard
      title={T('Tokens', 'Tokens')}
      hint={k === 'tokens' ? T('escritos en total', 'written in total') : T('promedio por intervención', 'average per intervention')}
      help={T('Cuánto escribe cada agente. Total: todos los tokens que produjo. Por turno: el largo típico de cada intervención. Un agente que escribe mucho no necesariamente aporta más.', 'How much each agent writes. Total: every token it produced. Per turn: the typical length of each intervention. Cost: what it spent in USD at its model price. An agent that writes a lot does not necessarily contribute more.')}
      right={<Seg value={k} onChange={setK} options={[{ key: 'tokens', label: 'total' }, { key: 'perTurn', label: T('por turno', 'per turn') }]} />}
      footer={top ? `${top.name} ${T('escribió el', 'wrote')} ${Math.round((100 * top.tokens) / total)}% ${T('del total', 'of the total')} (${fmtK(total)} tok)` : undefined}
    >
      {turns === 0 ? <Empty text={T('Todavía nadie habló.', 'Nobody has spoken yet.')} /> : (
        <Bars
          rows={rows}
          value={(r) => (k === 'tokens' ? r.tokens : r.perTurn)}
          fmt={fmtK}
          mean
          tip={(r) => (
            <div>
              <div className="font-semibold" style={{ color: r.color }}>{r.name} <span className="font-normal text-ink-3">· {T('llamado', 'called')} {r.calledBy}×</span></div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
                <span className="text-ink-3">total</span><span>{r.tokens.toLocaleString()} tok{total ? ` · ${Math.round((100 * r.tokens) / total)}%` : ''}</span>
                <span className="text-ink-3">{T('por turno', 'per turn')}</span><span>{r.perTurn.toLocaleString()} tok</span>
                {r.reasoning > 0 && <><span className="text-ink-3">{T('razonamiento', 'reasoning')}</span><span>{fmtK(r.reasoning)} tok</span></>}
                <span className="text-ink-3">{T('costo', 'cost')}</span><span>{fmtUsd(r.cost)}</span>
              </div>
            </div>
          )}
        />
      )}
    </ChartCard>
  )
}

const fmtUsdShort = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`

export function CostChart() {
  const T = useT()
  const { rows, turns } = useAgg()
  const total = rows.reduce((x, r) => x + r.cost, 0)
  const top = rows.length > 1 && total ? [...rows].sort((a, b) => b.cost - a.cost)[0] : null
  return (
    <ChartCard
      title={T('Costo', 'Cost')}
      hint={T('acumulado en USD, por agente', 'accumulated in USD, per agent')}
      help={T('Lo que gastó cada agente según el precio de lista de su modelo (entrada + salida). Un modelo caro que habla poco puede costar menos que uno barato que escribe de más.', 'What each agent spent at its model list price (input + output). An expensive model that speaks little can cost less than a cheap one that over-writes.')}
      footer={total > 0 ? `${T('Total', 'Total')} ${fmtUsd(total)}${top ? ` · ${top.name} ${Math.round((100 * top.cost) / total)}%` : ''}` : undefined}
    >
      {turns === 0 ? <Empty text={T('Todavía nadie habló.', 'Nobody has spoken yet.')} /> : total === 0 ? <Empty text={T('Sin costo por API en este debate.', 'No API cost in this debate.')} /> : (
        <Bars
          rows={rows}
          value={(r) => r.cost}
          fmt={fmtUsdShort}
          valueWidth={56}
          mean
          tip={(r) => (
            <div>
              <div className="font-semibold" style={{ color: r.color }}>{r.name}</div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
                <span className="text-ink-3">{T('costo', 'cost')}</span><span>{fmtUsd(r.cost)}{total ? ` · ${Math.round((100 * r.cost) / total)}%` : ''}</span>
                <span className="text-ink-3">tokens</span><span>{r.tokens.toLocaleString()}</span>
                <span className="text-ink-3">{T('por turno', 'per turn')}</span><span>{r.perTurn.toLocaleString()} tok</span>
              </div>
            </div>
          )}
        />
      )}
    </ChartCard>
  )
}

export function ConfidenceChart() {
  const T = useT()
  const { agents, rows, confSeries, turns } = useAgg()
  const colorOf = useAgentColor()
  const spot = useSpotlight()
  const declared = rows.reduce((x, r) => x + r.confN, 0)
  const ranked = [...rows].filter((r) => r.confAvg != null).sort((a, b) => (b.confAvg ?? 0) - (a.confAvg ?? 0))
  return (
    <ChartCard
      title={T('Confianza', 'Confidence')}
      hint={T('qué tan seguro dice estar cada uno, 0–100', 'how sure each one says it is, 0–100')}
      help={T('En cada turno el agente declara cuán seguro está de su postura (0 a 100). Una línea alta y estable es convicción; caídas marcan dudas o cambios de opinión. Pasá el mouse por un turno para ver todos los valores; clickeá un nombre para aislarlo.', 'Each turn the agent declares how sure it is of its stance (0 to 100). A high, steady line is conviction; drops mark doubts or changes of mind. Hover a turn to see every value; click a name to isolate it.')}
      footer={ranked.length > 1 ? `${T('Más seguro', 'Most confident')}: ${ranked[0].name} (${ranked[0].confAvg}) · ${T('más cauto', 'most cautious')}: ${ranked[ranked.length - 1].name} (${ranked[ranked.length - 1].confAvg})${declared < turns ? ` · ${turns - declared} ${T('turnos sin declarar', 'turns undeclared')}` : ''}` : undefined}
    >
      {turns === 0 ? <Empty text={T('Se dibuja a medida que los agentes declaran su confianza.', 'Drawn as the agents declare their confidence.')} /> : declared === 0 ? <Empty text={T('En esta corrida ningún agente declaró su confianza (respuestas cortadas o sin la etiqueta). Las corridas nuevas la piden en cada turno.', 'In this run no agent declared its confidence (answers cut short or missing the tag). New runs ask for it every turn.')} /> : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex max-h-8 shrink-0 flex-wrap gap-x-2.5 gap-y-0.5 overflow-hidden text-[10px] leading-tight text-ink-2">
            {rows.map((r) => (
              <button type="button" key={r.id} className={`flex cursor-pointer items-center gap-1 whitespace-nowrap rounded px-0.5 transition-opacity ${spot.pin === r.id ? 'bg-paper' : ''}`} style={{ opacity: spot.dim(r.id) }} title={`${r.name}${r.confAvg != null ? ` · ${T('promedio', 'average')} ${r.confAvg}` : ''}`} {...spot.bind(r.id)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                {short(r.name)}{r.confAvg != null && <span className="font-mono text-ink-3">{r.confAvg}</span>}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={confSeries} margin={{ left: -18, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid stroke="#E6EAE7" vertical={false} />
                <XAxis dataKey="turn" stroke="#A2ACA6" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} ticks={[0, 50, 100]} stroke="#A2ACA6" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ stroke: '#C5CDC8' }}
                  content={({ active, label }) => {
                    if (!active) return null
                    const row = confSeries.find((c) => c.turn === label)
                    const items = agents.map((a) => ({ a, v: row?.[a.id] as number | null | undefined })).filter((x) => x.v != null)
                    return (
                      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-[0_8px_24px_-10px_rgba(30,38,34,.35)]">
                        <div className="text-ink-3">{T('Turno', 'Turn')} {label}</div>
                        {items.map(({ a, v }) => <div key={a.id} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: colorOf(a) }} />{a.name} <span className="ml-auto pl-3 font-mono tabular-nums">{v}</span></div>)}
                      </div>
                    )
                  }}
                />
                {agents.map((a) => (
                  <Line key={a.id} name={a.name} dataKey={a.id} stroke={colorOf(a)} strokeWidth={spot.active === a.id ? 3 : 2} strokeOpacity={spot.dim(a.id)} connectNulls dot={{ r: 3, strokeWidth: 2, stroke: '#FFFFFF', fill: colorOf(a), fillOpacity: spot.dim(a.id) }} activeDot={{ r: 5 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </ChartCard>
  )
}

/** Who answers whom and how: row = speaker, column = the agent they were answering; the number is how many times,
 * the colour is the tone of those answers (agreements, disagreements, proposals, neutral). */
export function AgreementMatrix() {
  const T = useT()
  const config = useArena((s) => s.config)
  const turns = useArena((s) => s.turns)
  const colorOf = useAgentColor()
  const spot = useSpotlight()
  const t = useTip()
  const agents = config?.agents ?? []
  const map = agentMap(config)
  const stats = useMemo(() => {
    const cells: Record<string, { n: number; agree: number; disagree: number; propose: number; neutral: number }> = {}
    const key = (a: string, b: string) => `${a}→${b}`
    for (const x of turns) {
      if (!x.responding_to || x.responding_to === x.agent_id) continue
      const c = (cells[key(x.agent_id, x.responding_to)] ??= { n: 0, agree: 0, disagree: 0, propose: 0, neutral: 0 })
      c.n++
      c[x.stance]++
    }
    const maxN = Math.max(1, ...Object.values(cells).map((c) => c.n))
    const totals = Object.values(cells).reduce((acc, c) => ({ agree: acc.agree + c.agree, disagree: acc.disagree + c.disagree, propose: acc.propose + c.propose, n: acc.n + c.n }), { agree: 0, disagree: 0, propose: 0, n: 0 })
    // the busiest pair, counting both directions
    const pairs: Record<string, number> = {}
    for (const [k, c] of Object.entries(cells)) {
      const [a, b] = k.split('→')
      const pk = [a, b].sort().join('|')
      pairs[pk] = (pairs[pk] ?? 0) + c.n
    }
    const busiest = Object.entries(pairs).sort((a, b) => b[1] - a[1])[0]
    const get = (a: string, b: string) => cells[key(a, b)]
    return { get, maxN, totals, busiest }
  }, [turns])
  const tone = (c: { agree: number; disagree: number; propose: number; neutral: number } | undefined) => {
    if (!c) return null
    if (c.disagree > c.agree) return STANCE.disagree.color
    if (c.agree > c.disagree) return STANCE.agree.color
    if (c.propose) return STANCE.propose.color
    return STANCE.neutral.color
  }
  const bg = (a: string, b: string) => {
    const c = stats.get(a, b)
    if (!c) return 'transparent'
    const alpha = Math.round((0.18 + 0.62 * (c.n / stats.maxN)) * 255).toString(16).padStart(2, '0')
    return `${tone(c)}${alpha}`
  }
  const legend: [Stance, string][] = [['agree', T('acuerdo', 'agreement')], ['disagree', T('desacuerdo', 'disagreement')], ['propose', T('propuesta', 'proposal')], ['neutral', 'neutral']]
  const { totals, busiest } = stats
  const footer = turns.length === 0 ? undefined : totals.n === 0 ? T('Todavía nadie respondió a otro.', 'Nobody has answered anyone yet.') : (
    <>
      {busiest && <>{T('Dúo más activo', 'Most active pair')}: {busiest[0].split('|').map((id) => map[id]?.name ?? id).join(' ↔ ')} ({busiest[1]}) · </>}
      {totals.agree || totals.disagree ? `${totals.agree} ${T('acuerdos', 'agreements')} · ${totals.disagree} ${T('desacuerdos', 'disagreements')}` : T('sin acuerdos ni desacuerdos explícitos', 'no explicit agreements or disagreements')}
    </>
  )
  return (
    <ChartCard
      title={T('Alianzas', 'Alliances')}
      hint={T('fila responde a columna', 'row answers column')}
      help={T('Quién le contesta a quién y en qué tono. Cada fila es quien habla; cada columna, a quién le respondía. El número es cuántas veces pasó; el color, el tono dominante de esas respuestas: verde acuerdo, rojo desacuerdo, dorado propuesta, gris neutral. Cuanto más intenso, más intercambios.', 'Who answers whom and in what tone. Each row is the speaker; each column, who they were answering. The number is how many times it happened; the colour, the dominant tone of those answers: green agreement, red disagreement, gold proposal, grey neutral. The deeper the colour, the more exchanges.')}
      footer={footer}
    >
      {t.el}
      {turns.length === 0 ? <Empty text={T('Se completa a medida que los agentes se contestan.', 'Filled in as the agents answer each other.')} /> : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="grid min-h-0 flex-1 gap-[2px] font-mono text-[10.5px]" style={{ gridTemplateColumns: `64px repeat(${agents.length}, minmax(0,1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}>
            <div />
            {agents.map((a) => (
              <div key={a.id} className="cursor-default truncate text-center font-sans text-[10px] font-semibold transition-opacity" style={{ color: colorOf(a), opacity: spot.dim(a.id) }} title={a.name} {...spot.bind(a.id)}>{short(a.name, 9)}</div>
            ))}
            {agents.map((a) => (
              <div key={a.id} className="contents">
                <div className="cursor-default truncate self-center font-sans text-[10px] font-semibold transition-opacity" style={{ color: colorOf(a), opacity: spot.dim(a.id) }} title={a.name} {...spot.bind(a.id)}>{short(a.name, 9)}</div>
                {agents.map((b) => {
                  const c = stats.get(a.id, b.id)
                  const self = a.id === b.id
                  const dim = spot.active && spot.active !== a.id && spot.active !== b.id ? 0.3 : 1
                  return (
                    <div
                      key={b.id}
                      className="flex min-h-4 items-center justify-center rounded text-ink transition-opacity"
                      style={{ background: self ? '#F5F7F5' : bg(a.id, b.id), opacity: dim, color: c ? '#1E2622' : '#A2ACA6' }}
                      {...(c && !self ? t.bind(() => (
                        <div>
                          <div className="font-semibold">{a.name} <span className="text-ink-3">→</span> {b.name}</div>
                          <div className="text-ink-3">{c.n} {c.n === 1 ? T('respuesta', 'answer') : T('respuestas', 'answers')}</div>
                          <div className="mt-1 space-y-0.5">
                            {(['agree', 'disagree', 'propose', 'neutral'] as Stance[]).filter((s) => c[s]).map((s) => (
                              <div key={s} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STANCE[s].color }} />{stanceLabel(s)} <span className="ml-auto pl-3 font-mono tabular-nums">{c[s]}</span></div>
                            ))}
                          </div>
                        </div>
                      )) : {})}
                    >
                      {self ? '' : c ? c.n : '·'}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex shrink-0 flex-wrap gap-x-2.5 gap-y-0.5 text-[9.5px] leading-tight text-ink-3">
            {legend.map(([s, label]) => <span key={s} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: STANCE[s].color }} />{label}</span>)}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

export function Timeline() {
  const config = useArena((s) => s.config)
  const turns = useArena((s) => s.turns)
  const live = useArena((s) => s.live)
  const colorOf = useAgentColor()
  const spot = useSpotlight()
  const map = agentMap(config)
  const total = Math.max(config?.max_turns ?? 1, turns.length, live?.turn ?? 0)
  return (
    <div className="flex gap-1 h-7 items-stretch">
      {Array.from({ length: total }, (_, i) => {
        const t = turns[i]
        const isLive = !t && live && live.turn === i + 1
        const a = t ? map[t.agent_id] : isLive ? map[live!.agentId] : undefined
        const color = colorOf(a)
        return (
          <motion.div
            key={i}
            title={t ? `#${t.turn} ${a?.name} · ${STANCE[t.stance].label} · ${fmtMs(t.metrics.latency_ms)}` : undefined}
            className="flex-1 rounded-md flex items-center justify-center text-[11px] overflow-hidden"
            style={{ background: a ? `${color}${t ? '30' : '18'}` : 'var(--color-surface-2)', border: isLive ? `1px solid ${color}` : '1px solid transparent', opacity: a ? spot.dim(a.id) : 1 }}
            animate={isLive ? { opacity: [0.5, 1, 0.5] } : { opacity: a ? spot.dim(a.id) : 1 }}
            transition={isLive ? { repeat: Infinity, duration: 1.2 } : undefined}
            {...(a ? spot.bind(a.id) : {})}
          >
            {t ? (t.phase === 'closing' ? '📋' : STANCE[t.stance].emoji) : isLive ? '…' : ''}
          </motion.div>
        )
      })}
    </div>
  )
}
