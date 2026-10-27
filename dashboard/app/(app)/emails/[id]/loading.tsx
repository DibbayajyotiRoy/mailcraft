import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading email">
      <Skeleton className="mb-6 h-16 w-full max-w-md" />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="grid gap-6"><Skeleton className="h-[260px] rounded-lg" /><Skeleton className="h-[320px] rounded-lg" /></div>
        <Skeleton className="h-[300px] rounded-lg" />
      </div>
    </div>
  );
}
