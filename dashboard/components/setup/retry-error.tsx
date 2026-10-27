"use client";
import { useRouter } from "next/navigation";
import type { ApiError } from "@/lib/api";
import { ErrorState } from "@/components/ui/error-state";

/** ErrorState whose "Try again" re-runs the server component. */
export function RetryError({ error }: { error: ApiError }) {
  const router = useRouter();
  return <ErrorState error={error} onRetry={() => router.refresh()} />;
}
