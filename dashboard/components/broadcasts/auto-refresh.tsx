"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the server component every few seconds while a broadcast is still going out. Renders nothing. */
export function AutoRefresh({ active, every = 5000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), every);
    return () => clearInterval(id);
  }, [active, every, router]);
  return null;
}
