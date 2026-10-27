import { notFound } from "next/navigation";
import { Gallery } from "./Gallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Design system gallery" };

/** Dev-only visual regression page: every component x state, in the current theme and in a forced-dark panel. */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production" && process.env.MAILCRAFT_DEV_DESIGN !== "1") notFound();
  return (
    <main id="main" className="mx-auto max-w-[1200px] px-4 py-8 md:px-8">
      <h1 className="text-xl font-semibold tracking-[-.015em]">Design system</h1>
      <p className="mt-1 text-sm text-muted">Every component and state. The second panel forces the dark theme.</p>
      <div className="mt-8 grid gap-10">
        <Gallery />
        <div data-theme="dark" className="rounded-lg border border-border p-6"><h2 className="mb-6 text-lg font-semibold">Dark theme</h2><Gallery /></div>
      </div>
    </main>
  );
}
