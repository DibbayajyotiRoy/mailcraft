"use client";
import { TriangleAlert } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { CopyButton } from "./copy";

/** Human sentence first, code in mono below, hint as a tip. role=alert. Replaces ErrorBanner visually. */
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
