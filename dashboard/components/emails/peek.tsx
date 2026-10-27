"use client";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Dialog, DrawerContent } from "@/components/ui/dialog";
import { emailsHref, type EmailQuery } from "@/components/monitor/helpers";

/** Right-hand peek panel. Open state is the URL (`?open=`): Esc / overlay click / close removes it. */
export function Peek({ query, title, children }: { query: EmailQuery; title: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) router.replace(emailsHref(query, { open: undefined }), { scroll: false }); }}>
      <DrawerContent side="right" title={title} className="w-[min(480px,calc(100%-24px))] overflow-y-auto data-[state=open]:animate-fade-in">
        <div className="p-5">{children}</div>
      </DrawerContent>
    </Dialog>
  );
}
