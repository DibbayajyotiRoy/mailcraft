"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";

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
  return <SegmentedControl iconOnly label="Theme" value={t} onValueChange={pick} options={OPTS.map(([value, label, icon]) => ({ value, label, icon }))} />;
}
