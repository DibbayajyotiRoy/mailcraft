import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading API keys" className="grid gap-6">
      <Skeleton className="h-14 w-full" />
      <div className="grid gap-2 rounded-lg border border-border p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
    </div>
  );
}
