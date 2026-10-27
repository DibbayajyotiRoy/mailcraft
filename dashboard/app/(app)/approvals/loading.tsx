import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading approvals">
      <Skeleton className="mb-6 h-14 w-full max-w-xs" />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]"><Skeleton className="h-[420px] rounded-lg" /><Skeleton className="hidden h-[420px] rounded-lg lg:block" /></div>
    </div>
  );
}
