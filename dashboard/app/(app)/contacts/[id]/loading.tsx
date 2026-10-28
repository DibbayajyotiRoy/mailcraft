import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading contact">
      <Skeleton className="mb-6 h-16 w-full max-w-md" />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-6"><Skeleton className="h-[200px] rounded-lg" /><Skeleton className="h-[200px] rounded-lg" /><Skeleton className="h-[160px] rounded-lg" /></div>
        <div className="grid gap-6"><Skeleton className="h-[220px] rounded-lg" /><Skeleton className="h-[160px] rounded-lg" /></div>
      </div>
    </div>
  );
}
