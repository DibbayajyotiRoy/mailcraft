import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading automation">
      <Skeleton className="mb-2 h-4 w-32" />
      <Skeleton className="mb-6 h-7 w-64" />
      <Skeleton className="mb-4 h-9 w-full max-w-md" />
      <div className="mx-auto grid max-w-[560px] gap-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}</div>
    </div>
  );
}
