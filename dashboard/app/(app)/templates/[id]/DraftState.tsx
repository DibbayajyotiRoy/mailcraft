"use client";
import { Undo2 } from "lucide-react";
import { discardDraft } from "../actions";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/Confirm";
import { cn } from "@/lib/cn";
import { isUnpublished } from "./util";

/** Live vs draft at a glance: "Live v3" plus "Draft v5 unpublished", with Discard draft (back to the live version) when there is one. */
export function DraftState({ template: t, className }: { template: any; className?: string }) {
  const pending = isUnpublished(t), live = t.published_version;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-sm", className)}>
      {live != null ? <span className="text-muted">Live: <strong className="font-medium text-fg">v{live}</strong></span> : <span className="text-muted">Not published yet</span>}
      {pending && <Badge tone="info">Draft v{t.version} unpublished</Badge>}
      {pending && live != null && (
        <form action={discardDraft}>
          <input type="hidden" name="id" value={t.id} />
          <ConfirmButton className="danger" title="Discard the draft?" message={`Deletes every unpublished version after v${live}. Sends keep using v${live}. This cannot be undone.`}>Discard draft</ConfirmButton>
        </form>
      )}
    </div>
  );
}
