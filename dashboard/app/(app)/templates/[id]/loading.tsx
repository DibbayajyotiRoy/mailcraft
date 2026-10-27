import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-label="Loading template">
      <Skeleton className="mb-2 h-4 w-32" />
      <Skeleton className="mb-6 h-7 w-64" />
      <Skeleton className="mb-4 h-9 w-full max-w-md" />
      <Skeleton className="h-[480px] w-full rounded-lg" />
    </div>
  );
}
