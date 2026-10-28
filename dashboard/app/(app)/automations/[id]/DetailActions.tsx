"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Copy, MoreHorizontal, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { archiveAutomation } from "../actions";
import { TestRun } from "./TestRun";

/** Edit, Test run and a "More" menu (duplicate, archive / restore). Archived automations only offer Restore. */
export function DetailActions({ id, name, status, env, liveEnabled, contacts, types }: {
  id: string; name: string; status: string; env: "test" | "live"; liveEnabled: boolean; contacts: string[]; types: Record<string, string>;
}) {
  const [ask, setAsk] = useState(false);
  const [pending, start] = useTransition();
  const archived = status === "archived", enc = encodeURIComponent(id);
  const confirm = () => {
    const fd = new FormData();
    fd.set("id", id); fd.set("action", archived ? "unarchive" : "archive");
    start(async () => { await archiveAutomation(fd); });
  };
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
      {!archived && (
        <>
          <TestRun id={id} name={name} env={env} liveEnabled={liveEnabled} contacts={contacts} types={types} />
          <Link href={`/automations/${enc}/edit`} className={buttonVariants({ variant: "secondary" })}><Pencil aria-hidden />Edit</Link>
        </>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><Button variant="secondary" size="icon" aria-label="More actions" aria-busy={pending || undefined}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          {!archived && <DropdownMenuItem asChild><Link href={`/automations/new?from=${enc}`}><Copy aria-hidden />Duplicate</Link></DropdownMenuItem>}
          {archived
            ? <DropdownMenuItem onSelect={() => setAsk(true)}><ArchiveRestore aria-hidden />Restore as draft</DropdownMenuItem>
            : <DropdownMenuItem disabled={status === "active"} onSelect={() => setAsk(true)}><Archive aria-hidden />{status === "active" ? "Archive (pause it first)" : "Archive"}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={ask} onOpenChange={setAsk}>
        <AlertDialogContent title={archived ? `Restore “${name}”?` : `Archive “${name}”?`} destructive={!archived} confirmLabel={archived ? "Restore" : "Archive"} onConfirm={confirm}
          description={archived ? "It comes back as a draft. Publish it when you want it to run." : "It stops running and leaves the list. Contacts already inside are not sent anything further. You can restore it later."} />
      </AlertDialog>
    </div>
  );
}
