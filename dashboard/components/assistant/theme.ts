"use client";
import { useSyncExternalStore } from "react";

/** The theme the page is actually showing: the explicit `data-theme` on <html>, else the OS setting. For libraries that take a theme prop. */
function subscribe(cb: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)"), mo = new MutationObserver(cb);
  mq.addEventListener("change", cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => { mq.removeEventListener("change", cb); mo.disconnect(); };
}
const snap = (): "light" | "dark" => { const t = document.documentElement.dataset.theme; return t === "dark" || t === "light" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; };
export const useResolvedTheme = () => useSyncExternalStore(subscribe, snap, () => "light" as const);

const rmSub = (cb: () => void) => { const mq = matchMedia("(prefers-reduced-motion: reduce)"); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
/** For libraries whose reduced-motion handling is left to the consumer (border-beam's rotating types). */
export const useReducedMotion = () => useSyncExternalStore(rmSub, () => matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
