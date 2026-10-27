"use client";
import { useActionState, type ReactNode } from "react";
import { createKey } from "@/lib/actions";

/** Submit button that asks first (kill switch engage, revoke). */
export function ConfirmButton({ message, children, className }: { message: string; children: ReactNode; className?: string }) {
  return <button type="submit" className={className} onClick={(e) => { if (!confirm(message)) e.preventDefault(); }}>{children}</button>;
}

export function KeyForm() {
  const [s, act, pending] = useActionState(createKey, {} as { secret?: string; error?: string });
  return (
    <form action={act} className="stack">
      <label>Name<input name="name" required /></label>
      <label>Scopes (space or comma separated, optional)<input name="scopes" placeholder="emails:send templates:read" /></label>
      <button type="submit" disabled={pending}>Create key</button>
      {s.error && <div role="alert" className="banner">{s.error}</div>}
      {s.secret && (
        <div role="status" className="notice">
          Copy this secret now; it is shown only once.
          <pre><code>{s.secret}</code></pre>
        </div>
      )}
    </form>
  );
}
