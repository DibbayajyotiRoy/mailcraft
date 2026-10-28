import type { ReactNode } from "react";
import { Nav } from "./nav";
import { TopBar } from "./topbar";

/** App shell: environment hairline, sticky full-height sidebar (>=1024), top bar, main landmark. */
export function Shell({ env, killOn, pending, name, keyPrefix, theme, children }: {
  env: "live" | "test"; killOn: boolean | null; pending: number; name?: string; keyPrefix?: string; theme: "system" | "light" | "dark"; children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:flex">
      <div aria-hidden data-testid="env-hairline" className={`fixed inset-x-0 top-0 z-[60] h-0.5 ${env === "live" ? "bg-live" : "bg-test"}`} />
      {/* The wrapper stretches the full page height (surface + border); the aside inside stays pinned to the viewport. */}
      <div className="hidden w-58 shrink-0 border-r border-border bg-surface lg:block">
        <aside className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto px-3 pb-4 pt-5">
          <span className="px-3 text-md font-semibold tracking-[-.01em]">mailcraft</span>
          <Nav pending={pending} />
        </aside>
      </div>
      <div className="min-w-0 flex-1">
        <TopBar env={env} killOn={killOn} pending={pending} name={name} keyPrefix={keyPrefix} theme={theme} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
