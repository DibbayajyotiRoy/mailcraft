"use client";
import { ErrorState } from "@/components/ui/error-state";

export default function SettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState onRetry={reset} error={{ code: error.digest ?? "render_error", message: "Settings could not be shown.", hint: "Try again; if it keeps failing, check that the API is reachable." }} />;
}
