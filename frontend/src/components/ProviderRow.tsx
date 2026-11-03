import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { useT } from '../lib/i18n'
import ProviderLogo from './ProviderLogo'

/** Every company the app can seat at the table, with a line on what each one brings. */
const PROVIDERS: { id: string; name: string; company: string; models: string; es: string; en: string }[] = [
  { id: 'meta', name: 'Muse', company: 'Meta', models: 'Muse Wonder · Muse Spark 1.3 · Muse Code · Muse Image · SAM 3.1', es: 'El motor de Muse Team: ocupa todos los roles, construye con Muse Code, diseña con Muse Image y lee referencias con SAM 3.1.', en: 'Muse Team\'s engine: takes every role, builds with Muse Code, designs with Muse Image and reads references with SAM 3.1.' },
  { id: 'anthropic', name: 'Claude', company: 'Anthropic', models: 'Opus 5.5 · Sonnet 5.5 · Haiku 5.5', es: 'Razonamiento largo y código de calidad; el constructor por defecto vía Claude Code.', en: 'Long reasoning and quality code; the default builder through Claude Code.' },
  { id: 'openai', name: 'GPT', company: 'OpenAI', models: 'GPT-5.6 · o-series', es: 'Producto y arquitectura pragmáticos; también construye vía Codex.', en: 'Pragmatic product and architecture; also builds through Codex.' },
  { id: 'deepseek', name: 'DeepSeek', company: 'DeepSeek', models: 'V4 · R1', es: 'Muy barato y bueno en código; ideal para roles que escriben mucho.', en: 'Very cheap and strong at code; ideal for roles that write a lot.' },
  { id: 'gemini', name: 'Gemini', company: 'Google', models: 'Gemini 3.8 Pro · Flash', es: 'Contexto enorme y visión: lee briefs largos y capturas de referentes.', en: 'Huge context and vision: reads long briefs and reference screenshots.' },
  { id: 'xai', name: 'Grok', company: 'xAI', models: 'Grok 5', es: 'Directo y contrario: buen abogado del diablo en el debate.', en: 'Direct and contrarian: a good devil’s advocate in the debate.' },
  { id: 'groq', name: 'Llama', company: 'Groq', models: 'Llama 4 · a cientos de tokens por segundo', es: 'Modelos abiertos a velocidad extrema; rondas rápidas y baratas.', en: 'Open models at extreme speed; fast, cheap rounds.' },
  { id: 'kimi', name: 'Kimi', company: 'Moonshot AI', models: 'Kimi K2', es: 'Fuerte en agentes y herramientas; buen Head of Engineering.', en: 'Strong on agents and tools; a good Head of Engineering.' },
  { id: 'mistral', name: 'Mistral', company: 'Mistral AI', models: 'Large · Codestral', es: 'Europeo, eficiente y sólido en código.', en: 'European, efficient and solid at code.' },
  { id: 'openrouter', name: 'OpenRouter', company: '300+ modelos', models: 'una API key, todos los modelos', es: 'Una sola key para probar cualquier modelo del mercado en cualquier rol.', en: 'One key to try any model on the market in any role.' },
  { id: 'ollama', name: 'Ollama', company: 'modelos locales', models: 'Llama · Qwen · Gemma en tu máquina', es: 'Corre en tu computadora, sin API ni costo; privacidad total.', en: 'Runs on your machine, no API and no cost; total privacy.' },
]

export default function ProviderRow({ size = 'md', className = '' }: { size?: 'sm' | 'md'; className?: string }) {
  const T = useT()
  const [open, setOpen] = useState<string | null>(null)
  const sel = PROVIDERS.find((p) => p.id === open)
  const dim = size === 'sm' ? 'h-10 w-10' : 'h-11 w-11'
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {PROVIDERS.map((p, i) => {
          const on = open === p.id
          return (
            <motion.button
              key={p.id}
              type="button"
              aria-label={`${p.name} · ${p.company}`}
              aria-expanded={on}
              onClick={() => setOpen(on ? null : p.id)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, scale: on ? 1.22 : 1 }}
              whileHover={{ y: -4, scale: on ? 1.22 : 1.06 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22, delay: 0 }}
              style={{ transitionDelay: `${i * 0.04}s` }}
              className={`flex ${dim} cursor-pointer items-center justify-center rounded-full border bg-surface transition-[box-shadow,border-color] ${on ? 'border-accent shadow-[0_12px_28px_-10px_rgba(47,107,93,.55),0_0_0_4px_rgba(47,107,93,.14)]' : 'border-line shadow-sm hover:border-accent hover:shadow-[0_12px_24px_-12px_rgba(30,38,34,.45)]'}`}
            >
              <ProviderLogo provider={p.id} size={size === 'sm' ? 22 : 24} />
            </motion.button>
          )
        })}
      </div>
      <AnimatePresence mode="wait">
        {sel && (
          <motion.div
            key={sel.id}
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -4, height: 0, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="overflow-hidden"
          >
            <div className="mt-3 flex items-start gap-3 rounded-xl border border-line bg-surface/90 px-3.5 py-3 shadow-sm backdrop-blur">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface"><ProviderLogo provider={sel.id} size={20} /></span>
              <div className="min-w-0 text-[13px] leading-snug">
                <div className="font-semibold text-ink">{sel.name} <span className="font-normal text-ink-3">· {sel.company}</span></div>
                <div className="mt-0.5 text-ink-2">{T(sel.es, sel.en)}</div>
                <div className="mt-1 font-mono text-[10.5px] text-ink-3">{sel.models}</div>
              </div>
              <button type="button" onClick={() => setOpen(null)} className="ml-auto shrink-0 text-ink-3 hover:text-ink" aria-label={T('Cerrar', 'Close')}>×</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
