import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading templates">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-5 w-80" />
      <Skeleton className="mb-4 h-8 w-full max-w-sm" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/3] h-auto w-full rounded-lg" />)}
      </div>
    </div>
  );
}
