"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";

/** Unsaved-changes guard. While `dirty`: the browser asks before a reload/close (beforeunload), and a click on any in-app link
 *  opens a confirm dialog instead of navigating. Render `dialog`; wrap your own leave actions (Close) in `ask(fn)`.
 *  ponytail: the browser Back button is not intercepted (App Router exposes no navigation-blocking API). */
export function useUnsavedGuard(dirty: boolean): { dialog: ReactNode; ask: (leave: () => void) => void } {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const leave = useRef<() => void>(() => {});
  const ask = useCallback((fn: () => void) => {
    if (!dirty) return fn();
    leave.current = fn;
    setPending(true);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      ask(() => router.push(url.pathname + url.search + url.hash));
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onClick, true); };
  }, [dirty, ask, router]);

  const dialog = (
    <AlertDialog open={pending} onOpenChange={setPending}>
      <AlertDialogContent title="Discard unsaved changes?" description="Your edits to this template have not been saved. If you leave now they are lost."
        confirmLabel="Discard and leave" cancelLabel="Keep editing" onConfirm={() => leave.current()} />
    </AlertDialog>
  );
  return { dialog, ask };
}
