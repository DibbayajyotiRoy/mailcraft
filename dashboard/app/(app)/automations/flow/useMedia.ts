import { useSyncExternalStore } from "react";

/** A media query as state. False on the server and in the first client render, so markup never differs between them. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => { const m = window.matchMedia?.(query); m?.addEventListener("change", notify); return () => m?.removeEventListener("change", notify); },
    () => !!window.matchMedia?.(query).matches,
    () => false,
  );
}
