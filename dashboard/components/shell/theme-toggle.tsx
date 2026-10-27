"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

export const THEME_COOKIE = "mc_theme";
type Theme = "system" | "light" | "dark";
const OPTS: [Theme, string, typeof Sun][] = [["system", "System", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]];

/** 3-state toggle. Persisted in a cookie so the root layout can render data-theme server-side (no flash). */
export function ThemeToggle({ initial = "system" }: { initial?: Theme }) {
  const [t, setT] = useState<Theme>(initial);
  function pick(n: Theme) {
    setT(n);
    if (n === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = n;
    document.cookie = `${THEME_COOKIE}=${n}; path=/; max-age=31536000; samesite=lax`;
  }
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {OPTS.map(([v, label, Icon]) => (
        <button key={v} type="button" role="radio" aria-checked={t === v} aria-label={label} onClick={() => pick(v)}
          className={cn("grid size-7 place-items-center rounded-sm text-muted transition-colors duration-[var(--dur-fast)] hover:text-fg pointer-coarse:size-10", t === v && "bg-bg text-fg shadow-[0_0_0_1px_var(--border)]")}>
          <Icon aria-hidden className="size-4" />
        </button>
      ))}
    </div>
  );
}
