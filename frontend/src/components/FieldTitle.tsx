/** A field's name, large enough to scan the form, and what it is for right below it. */
export default function FieldTitle({ title, sub, className = '' }: { title: string; sub?: string; className?: string }) {
  return (
    <span className={`block ${className}`}>
      <span className="block text-[15px] font-semibold leading-tight text-ink">{title}</span>
      {sub && <span className="mt-0.5 block text-[12.5px] font-normal leading-snug text-ink-3">{sub}</span>}
    </span>
  )
}
