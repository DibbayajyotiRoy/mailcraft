"use client";
import { ErrorState } from "@/components/ui/error-state";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorState error={{ code: "render_error", message: "Domains could not be shown.", hint: error.message }} onRetry={reset} />;
}
