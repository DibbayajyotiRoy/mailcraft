import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { get, session } from "@/lib/api";
import { logout, setKill } from "@/lib/actions";
import { ConfirmButton } from "@/components/Confirm";

export const dynamic = "force-dynamic";

const NAV = [["/", "Overview"], ["/emails", "Emails"], ["/domains", "Domains"], ["/templates", "Templates"], ["/contacts", "Contacts"], ["/automations", "Automations"], ["/approvals", "Approvals"], ["/keys", "Keys"], ["/settings", "Settings"]];

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await session())) redirect("/login");
  const ks = await get("/v1/kill-switch");
  const on: boolean | null = ks.error ? null : !!ks.data?.on;
  return (
    <>
      <header className="top">
        <strong>mailcraft</strong>
        <nav aria-label="Main"><ul>{NAV.map(([h, l]) => <li key={h}><Link href={h}>{l}</Link></li>)}</ul></nav>
        <div className="kill">
          <span role="status" className={`badge ${on === null ? "neutral" : on ? "bad" : "ok"}`}>
            Kill switch: {on === null ? "unknown" : on ? "ENGAGED" : "off"}
          </span>
          {on !== null && (
            <form action={setKill}>
              <input type="hidden" name="on" value={String(!on)} />
              {on ? <button type="submit">Release</button>
                : <ConfirmButton className="danger" message="Engage the kill switch? All sending stops immediately.">Engage</ConfirmButton>}
            </form>
          )}
          <form action={logout}><button type="submit" className="link">Sign out</button></form>
        </div>
      </header>
      <main id="main">{children}</main>
    </>
  );
}
