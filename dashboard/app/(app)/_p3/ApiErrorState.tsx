"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ApiError } from "@/lib/api";
import { ErrorState } from "@/components/ui/error-state";

/** ErrorState whose retry re-runs the server component (router.refresh). */
export function ApiErrorState({ error }: { error: ApiError }) {
  const router = useRouter();
  const [, start] = useTransition();
  return <ErrorState error={error} onRetry={() => start(() => router.refresh())} />;
}
