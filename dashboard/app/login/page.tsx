import { DEFAULT_BASE } from "@/lib/api";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · mailcraft" };

function Mark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <rect x="4" y="8" width="24" height="16" rx="3" /><path d="m5 10 11 8 11-8" />
    </svg>
  );
}

export default async function Login({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <aside aria-hidden className="relative hidden overflow-hidden bg-accent-soft lg:block">
        <svg viewBox="0 0 400 600" className="absolute inset-0 size-full text-accent opacity-20" fill="none" stroke="currentColor" strokeWidth="1.5" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 7 }, (_, i) => <path key={i} d={`M-20 ${80 + i * 80} C 120 ${20 + i * 80}, 240 ${220 + i * 80}, 420 ${100 + i * 80}`} />)}
          {[[70, 130], [190, 250], [310, 190], [150, 410], [290, 470]].map(([x, y]) => <rect key={x} x={x} y={y} width="36" height="24" rx="4" className="fill-bg" />)}
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12">
          <span className="flex items-center gap-2 text-lg font-semibold"><Mark className="size-7 text-accent" />mailcraft</span>
          <p className="max-w-xs text-balance text-3xl font-semibold tracking-[-.02em]">Email your agents can run.</p>
        </div>
      </aside>
      <main id="main" className="grid place-items-center px-4 py-12">
        <div className="w-full max-w-[360px]">
          <span className="mb-8 flex items-center gap-2 text-lg font-semibold lg:hidden"><Mark className="size-6 text-accent" />mailcraft</span>
          <h1 className="text-xl font-semibold tracking-[-.01em]">Sign in</h1>
          <p className="mb-6 mt-1 text-sm text-muted">Use an API key from your mailcraft server.</p>
          <LoginForm err={err} defaultBase={DEFAULT_BASE} />
          <p className="mt-6 text-xs text-muted">
            The key is kept in an httpOnly cookie and only the dashboard server uses it.{" "}
            <a data-ui="link" href="https://github.com/DibbayajyotiRoy/mailcraft/blob/main/docs/QUICKSTART.md" className="underline underline-offset-2 hover:text-fg">Need a key? Read the quickstart</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
