"use client";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { CopyField } from "@/components/ui/copy";
import { Dialog, DialogClose, DrawerContent } from "@/components/ui/dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { KeyValue } from "@/components/ui/stat-card";
import { cn } from "@/lib/cn";
import { fullName, isSuppressed, topicList, type Contact } from "./util";

const show = (v: unknown) => (v == null || v === "" ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Right-hand peek: everything we know about one contact, from the list row (no extra request). */
export function ContactDrawer({ contact: c, onClose }: { contact: Contact | null; onClose: () => void }) {
  const props = Object.entries(c?.properties ?? {});
  const topics = c ? topicList(c) : [];
  return (
    <Dialog open={c !== null} onOpenChange={(o) => !o && onClose()}>
      {c && (
        <DrawerContent side="right" title={`Contact ${c.email}`} className="w-[min(440px,calc(100%-24px))] data-[state=open]:animate-fade-in overflow-y-auto">
          <div className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <h2 className="break-words text-md font-medium">{fullName(c) || c.email}</h2>
              {fullName(c) && <p className="break-words text-sm text-muted">{c.email}</p>}
            </div>
            <DialogClose aria-label="Close contact" className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}><X aria-hidden /></DialogClose>
          </div>
          <div className="grid gap-6 p-4">
            {isSuppressed(c) && (
              <div role="status" className="rounded-lg border border-bad/40 bg-bad-bg p-3 text-sm text-bad">
                <Badge tone="bad" size="sm" className="border border-bad">suppressed</Badge>
                <p className="mt-2">We will not send to this address.{c.suppression_reason ? ` Reason: ${c.suppression_reason}.` : ""}</p>
              </div>
            )}
            <section aria-labelledby="c-details"><h3 id="c-details" className="mb-2 text-sm font-medium">Details</h3>
              <KeyValue items={[
                ["Timezone", show(c.timezone)],
                ["Added", c.created_at ? <RelativeTime value={c.created_at} /> : "-"],
                ...(c.id ? [["ID", <CopyField key="id" value={c.id} label="contact id" />] as [string, React.ReactNode]] : []),
              ]} />
            </section>
            <section aria-labelledby="c-props"><h3 id="c-props" className="mb-2 text-sm font-medium">Properties</h3>
              {props.length ? <KeyValue items={props.map(([k, v]) => [<code key={k} className="text-[12.5px]">{k}</code>, show(v)])} /> : <p className="text-sm text-muted">No custom properties.</p>}
            </section>
            <section aria-labelledby="c-topics"><h3 id="c-topics" className="mb-2 text-sm font-medium">Topics and subscription</h3>
              {topics.length ? (
                <ul className="flex flex-wrap gap-2">{topics.map((t) => <li key={t.name}><Badge tone={t.subscribed ? "ok" : "neutral"}>{t.name}: {t.subscribed ? "subscribed" : "unsubscribed"}</Badge></li>)}</ul>
              ) : <p className="text-sm text-muted">No topic preferences recorded.</p>}
            </section>
          </div>
        </DrawerContent>
      )}
    </Dialog>
  );
}
