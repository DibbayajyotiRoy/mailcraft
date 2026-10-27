"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { Toaster as Sonner, toast } from "sonner";
import { FLASH_PARAM } from "@/lib/flash";

export { toast };

/** Mount once in the root layout. Bottom-right, 4s; sonner's list is role=region with polite announcements and never steals focus. */
export function Toaster() {
  return <Sonner position="bottom-right" duration={4000} closeButton
    toastOptions={{ style: { background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)", borderRadius: "var(--r-md)" } }} />;
}

function Flash() {
  const q = useSearchParams(), path = usePathname(), router = useRouter(), shown = useRef<string | null>(null);
  const msg = q.get(FLASH_PARAM);
  useEffect(() => {
    if (!msg || shown.current === msg) return;
    shown.current = msg;
    toast.success(msg);
    const n = new URLSearchParams(q.toString());
    n.delete(FLASH_PARAM);
    router.replace(n.size ? `${path}?${n}` : path, { scroll: false });
  }, [msg, q, path, router]);
  return null;
}

/** Shows `?ok=<message>` (see lib/flash.ts) as a success toast once, then strips it from the URL. */
export const FlashToast = () => <Suspense><Flash /></Suspense>;
