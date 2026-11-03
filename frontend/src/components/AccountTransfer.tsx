import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../lib/api'
import { tr, useT } from '../lib/i18n'
import { toast } from './Toast'

/**
 * Move this account to another Muse Team (e.g. from a local install to the online version): projects, versions, team, memory, published
 * apps and keys, as one encrypted file plus a code shown once. Importing never overwrites what the other account already has.
 */
export default function AccountTransfer() {
  const T = useT()
  const [exporting, setExporting] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importCode, setImportCode] = useState('')
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const doExport = async () => {
    setExporting(true)
    try {
      const r = await api.accountExport()
      const url = URL.createObjectURL(r.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = r.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      setCode(r.code)
    } catch (e) {
      toast.error(tr('No se pudo exportar', 'Could not export'), (e as Error).message)
    } finally {
      setExporting(false)
    }
  }
  const doImport = async () => {
    if (!file) return
    setImporting(true)
    setDone(null)
    try {
      const r = await api.accountImport(file, importCode)
      const rows = Object.values(r.rows).reduce((n, v) => n + v, 0)
      setDone(tr(`Listo: ${r.files} archivos y ${rows} registros importados${r.skipped_files ? ` (${r.skipped_files} ya estaban)` : ''}. Volvé al inicio: tus proyectos ya están acá.`, `Done: ${r.files} files and ${rows} records imported${r.skipped_files ? ` (${r.skipped_files} were already here)` : ''}. Go home: your projects are here.`))
      setFile(null)
      setImportCode('')
    } catch (e) {
      toast.error(tr('No se pudo importar', 'Could not import'), (e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="mt-10">
      <div className="text-xs uppercase tracking-[0.3em] text-ink-3">{T('Tu cuenta', 'Your account')}</div>
      <h2 className="mt-1 text-3xl">{T('Mover tu cuenta a otro Muse Team', 'Move your account to another Muse Team')}</h2>
      <p className="mt-1 text-[13px] text-ink-2">{T('Por ejemplo, de tu Muse Team local a la versión online: tus proyectos con todas sus versiones, tu equipo y su memoria, las apps publicadas y tus keys, en un archivo cifrado. En el otro Muse Team lo importás con el código y seguís trabajando donde quedaste.', 'For example, from your local Muse Team to the online version: your projects with all their versions, your team and its memory, published apps and your keys, in one encrypted file. In the other Muse Team you import it with the code and keep working where you left off.')}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="panel rounded-2xl p-5">
          <div className="flex items-center gap-2 font-semibold"><ArrowDownToLine size={16} className="text-accent" /> {T('1. Exportar desde acá', '1. Export from here')}</div>
          <p className="mt-1 text-[12.5px] text-ink-3">{T('Descarga un archivo .tably y te muestra un código. Guardá los dos: sin el código el archivo no se puede abrir.', 'Downloads a .tably file and shows you a code. Keep both: without the code the file cannot be opened.')}</p>
          <button onClick={doExport} disabled={exporting} className="mt-3 flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50">
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />} {T('Exportar mi cuenta', 'Export my account')}
          </button>
          {code && (
            <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-3.5 py-3">
              <div className="text-[12px] text-ink-2">{T('Tu código (se muestra una sola vez):', 'Your code (shown only once):')}</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="font-mono text-[18px] font-semibold tracking-wider text-ink">{code}</code>
                <button onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }} className="flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-[12px] text-ink-2 hover:border-accent hover:text-accent">
                  {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? T('Copiado', 'Copied') : T('Copiar', 'Copy')}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="panel rounded-2xl p-5">
          <div className="flex items-center gap-2 font-semibold"><ArrowUpFromLine size={16} className="text-accent" /> {T('2. Importar en este Muse Team', '2. Import into this Muse Team')}</div>
          <p className="mt-1 text-[12.5px] text-ink-3">{T('Elegí el archivo .tably, pegá su código y listo. No pisa nada de lo que ya tengas en esta cuenta.', 'Pick the .tably file, paste its code and that is it. It overwrites nothing you already have in this account.')}</p>
          <input ref={fileRef} type="file" accept=".tably" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => fileRef.current?.click()} className="flex h-9 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-ink-2 transition hover:border-accent hover:text-accent">{file ? file.name : T('Elegir archivo', 'Choose file')}</button>
            <input value={importCode} onChange={(e) => setImportCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="h-9 w-[210px] rounded-full border border-line bg-surface px-3.5 font-mono text-[13px] uppercase outline-none focus:border-accent" />
            <button onClick={doImport} disabled={!file || importCode.replace(/[^a-z0-9]/gi, '').length < 16 || importing} className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40">
              {importing ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpFromLine size={14} />} {T('Importar', 'Import')}
            </button>
          </div>
          {done && <div className="mt-3 flex items-start gap-2 rounded-xl border border-ok/30 bg-ok/5 px-3 py-2.5 text-[12.5px] text-ink-2"><Check size={15} className="mt-0.5 shrink-0 text-ok" /> {done}</div>}
        </div>
      </div>
    </section>
  )
}
