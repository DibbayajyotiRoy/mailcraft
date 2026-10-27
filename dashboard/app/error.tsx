"use client";
import { ErrorState } from "@/components/ui/error-state";

/** Catches render errors below the root layout (e.g. login, not-found). The app shell has its own boundary in (app)/error.tsx. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <h1 className="mb-3 text-lg font-semibold">Something went wrong</h1>
        <ErrorState onRetry={reset} error={{ code: error.digest ?? "render_error", message: "This page failed to load.", hint: "Try again. If it keeps happening, check that the API is running." }} />
      </div>
    </main>
  );
}
