import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { get, session } from "@/lib/api";
import { Shell } from "@/components/shell/shell";
import { THEME_COOKIE } from "@/components/shell/theme-toggle";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await session())) redirect("/login");
  const [ks, st] = await Promise.all([get("/v1/kill-switch"), get("/v1/account/status")]);
  const on: boolean | null = ks.error ? (st.data ? !!st.data.kill_switch : null) : !!ks.data?.on;
  const t = (await cookies()).get(THEME_COOKIE)?.value;
  return (
    <Shell env={st.data?.env === "live" ? "live" : "test"} killOn={on} pending={st.data?.pending_approvals ?? 0}
      name={st.data?.workspace?.name ?? st.data?.name} keyPrefix={st.data?.key_prefix} theme={t === "light" || t === "dark" ? t : "system"}>
      {children}
    </Shell>
  );
}
