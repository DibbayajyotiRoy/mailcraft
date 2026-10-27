import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading emails">
      <Skeleton className="mb-6 h-14 w-full max-w-xs" />
      <Skeleton className="mb-4 h-8 w-full max-w-2xl" />
      <div className="grid gap-px overflow-hidden rounded-lg border border-border">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 rounded-none" />)}</div>
    </div>
  );
}
