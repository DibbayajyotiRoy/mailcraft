"use client";
import "./globals.css";

/** Last resort: the root layout itself failed, so render a bare document. Plain markup, no providers. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main id="main" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}>
          <div role="alert" style={{ maxWidth: 420 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>mailcraft hit an unexpected error</h1>
            <p style={{ margin: "8px 0 16px", color: "var(--fg-muted)" }}>Reload the page. If it keeps happening, check that the server is running.</p>
            <button onClick={reset} data-ui="button" style={{ height: 36, padding: "0 16px", borderRadius: 6, background: "var(--accent)", color: "var(--accent-fg)", font: "inherit", fontWeight: 500 }}>Try again</button>
          </div>
        </main>
      </body>
    </html>
  );
}
