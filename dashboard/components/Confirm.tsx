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
      <label>Environment<select name="env"><option>test</option><option>live</option></select></label>
      <label>Scopes (read, send, manage; space or comma separated)<input name="scopes" defaultValue="read send" /></label>
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
