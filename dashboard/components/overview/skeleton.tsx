import { Skeleton } from "@/components/ui/skeleton";

/** Suspense fallback for the Overview page (a group-level loading.tsx would also cover every other route). */
export function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading overview">
      <Skeleton className="mb-6 h-14 w-full max-w-sm" />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
      <Skeleton className="mb-6 h-[300px] rounded-lg" />
      <Skeleton className="h-[260px] rounded-lg" />
    </div>
  );
}
