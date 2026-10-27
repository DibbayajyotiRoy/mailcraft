"use client";
import { KeyRound, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteDomain, rotateDkim } from "@/lib/actions";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { TypeNameConfirm } from "@/components/setup/type-name-confirm";

/** DKIM rotate + delete. Rotate asks first (the old key stops signing once the new record is live); delete needs the name typed. */
export function DomainMenu({ id, name }: { id: string; name: string }) {
  const [dlg, setDlg] = useState<"rotate" | "delete" | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${name}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setDlg("rotate")}><KeyRound aria-hidden />Rotate DKIM key</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDlg("delete")}><Trash2 aria-hidden />Delete domain</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={dlg === "rotate"} onOpenChange={(o) => !o && setDlg(null)}>
        <AlertDialogContent title="Rotate DKIM key?" destructive={false} confirmLabel="Rotate key"
          description={`A new DKIM record is generated for ${name}. Publish it at your DNS provider, then verify. Mail keeps signing with the old key until the new record is live.`}
          onConfirm={() => { const d = new FormData(); d.set("id", id); void rotateDkim(d); }} />
      </AlertDialog>
      <TypeNameConfirm open={dlg === "delete"} onOpenChange={(o) => !o && setDlg(null)} title="Delete domain"
        description="Mail from this domain stops sending and its DNS records are forgotten. This cannot be undone."
        expected={name} confirmLabel="Delete domain" action={deleteDomain} fields={{ id, name }} />
    </>
  );
}
