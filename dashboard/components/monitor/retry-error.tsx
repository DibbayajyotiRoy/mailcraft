"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ApiError } from "@/lib/api";
import { ErrorState } from "@/components/ui/error-state";

/** ErrorState whose "Try again" re-runs the server render (router.refresh). */
export function RetryError({ error }: { error: ApiError }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <div aria-busy={pending}><ErrorState error={error} onRetry={() => start(() => router.refresh())} /></div>;
}

/** Body of a route-level error.tsx: render failures get the same retry affordance (`reset`). */
export function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState error={{ code: error.digest ? `render_failed (${error.digest})` : "render_failed", message: error.message || "This page failed to load.", hint: "Try again; if it keeps failing, check that the API is reachable." }} onRetry={reset} />;
}
