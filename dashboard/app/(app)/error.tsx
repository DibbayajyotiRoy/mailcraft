"use client";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/error-state";

/** Inside the shell: navigation stays usable while the page content shows the error. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title="Something went wrong" />
      <ErrorState className="max-w-xl" onRetry={reset} error={{ code: error.digest ?? "render_error", message: "This page failed to load.", hint: "Try again. If it keeps happening, check that the API is running." }} />
    </>
  );
}
