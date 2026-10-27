"use client";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { CopyButton } from "./copy";
import { PageHeader } from "./page-header";

/** Human sentence first, code in mono below, hint as a tip. role=alert. Also the home of the page-level wrappers below. */
export function ErrorState({ error, onRetry, className }: { error: ApiError; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex gap-3 rounded-lg border border-bad/40 bg-bad-bg p-4 text-bad", className)}>
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{error.message}</p>
        <p className="mt-0.5 font-mono text-xs"><strong>{error.code}</strong></p>
        {error.hint && <p className="mt-2 text-sm">Hint: {error.hint}</p>}
        {error.doc_url && <p className="mt-1 text-sm"><a href={error.doc_url} className="underline">Documentation</a></p>}
        <div className="mt-3 flex gap-2">
          {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}
          <span className="inline-flex items-center text-xs"><CopyButton value={`${error.code}: ${error.message}`} label="Copy error details" />Copy details</span>
        </div>
      </div>
    </div>
  );
}

/** ErrorState whose "Try again" re-runs the server component (router.refresh). */
export function RetryError({ error, className }: { error: ApiError; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <div aria-busy={pending}><ErrorState className={className} error={error} onRetry={() => start(() => router.refresh())} /></div>;
}

/** Body of every route-level error.tsx: page title + a generic message (never the raw exception text); next's `reset()` is the retry. */
export function RouteError({ title, error, reset }: { title: string; error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title={title} />
      <ErrorState className="max-w-xl" onRetry={reset} error={{ code: error.digest ? `render_failed (${error.digest})` : "render_failed", message: "Something went wrong while loading this page.", hint: "Try again. If it keeps happening, check that the API is reachable." }} />
    </>
  );
}
