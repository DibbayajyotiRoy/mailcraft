import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading broadcast">
      <Skeleton className="mb-6 h-14 w-full max-w-xs" />
      <div className="grid gap-px overflow-hidden rounded-lg border border-border">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 rounded-none" />)}</div>
    </div>
  );
}
