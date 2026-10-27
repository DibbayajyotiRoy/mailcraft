import { Skeleton } from "@/components/ui/skeleton";

/** Default route skeleton: header + a few content blocks. Pages with their own loading.tsx override it. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="mb-2 h-6 w-40" /><Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <div className="grid gap-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
    </div>
  );
}
