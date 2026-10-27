"use client";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/error-state";

/** Body of every route-level error.tsx: next's `reset()` is the retry. */
export function RouteError({ title, error, reset }: { title: string; error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title={title} />
      <ErrorState error={{ code: "unexpected_error", message: "Something went wrong while loading this page.", hint: error.digest ? `Reference ${error.digest}` : undefined }} onRetry={reset} />
    </>
  );
}
