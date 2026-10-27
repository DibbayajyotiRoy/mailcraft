import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading contacts">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-5 w-72" />
      <Skeleton className="mb-4 h-9 w-56" />
      <Skeleton className="mb-4 h-8 w-full max-w-sm" />
      <div className="grid gap-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
    </div>
  );
}
