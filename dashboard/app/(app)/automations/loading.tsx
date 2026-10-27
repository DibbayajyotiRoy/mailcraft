import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading automations">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-6 h-5 w-72" />
      <div className="grid gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
    </div>
  );
}
