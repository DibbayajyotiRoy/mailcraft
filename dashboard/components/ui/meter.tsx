/** "2 of 4 verified" progress meter. role=progressbar with a text value, so it is never colour-only. Turns green when complete. */
export function Meter({ done, total, label = "Records verified", unit = "records verified" }: { done: number; total: number; label?: string; unit?: string }) {
  const full = total > 0 && done === total;
  return (
    <div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${done} of ${total} verified`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full transition-[width] duration-[var(--dur-base)] ${full ? "bg-ok" : "bg-accent"}`} style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
      </div>
      <p className="mt-1 text-sm tabular-nums"><strong>{done} of {total}</strong> <span className="text-muted">{unit}</span></p>
    </div>
  );
}
