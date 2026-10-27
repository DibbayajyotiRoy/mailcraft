import { login } from "@/lib/actions";
import { DEFAULT_BASE } from "@/lib/api";
import { ActionError } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  return (
    <main id="main" className="narrow mx-auto w-full px-4 py-16">
      <h1>Sign in to mailcraft</h1>
      <ActionError err={err} />
      <form action={login} className="stack">
        <label>API base URL<input name="base" type="url" required defaultValue={DEFAULT_BASE} /></label>
        <label>API key<input name="key" type="password" required autoComplete="off" placeholder="mc_test_..." /></label>
        <button type="submit">Sign in</button>
      </form>
      <p className="muted">The key is stored in an httpOnly cookie and only used by the dashboard server.</p>
    </main>
  );
}
