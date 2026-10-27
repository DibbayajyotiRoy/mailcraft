import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading settings">
      <Skeleton className="mb-2 h-6 w-32" /><Skeleton className="mb-6 h-4 w-72" />
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,720px)] lg:gap-10">
        <div className="hidden gap-2 lg:grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
        <div className="grid gap-6">{[200, 280, 320].map((h) => <Skeleton key={h} className="rounded-lg" style={{ height: h }} />)}</div>
      </div>
    </div>
  );
}
