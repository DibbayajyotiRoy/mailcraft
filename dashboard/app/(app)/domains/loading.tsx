import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading domains" className="grid gap-6">
      <Skeleton className="h-14 w-full" />
      {[0, 1].map((i) => (
        <div key={i} className="grid gap-3 rounded-lg border border-border p-4">
          <Skeleton className="h-5 w-64 max-w-full" /><Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}
