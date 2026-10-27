"use client";
import { useState } from "react";
import { publishTemplate } from "../actions";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { Rocket } from "lucide-react";

/** Publish asks first: published versions are what sends and automations use. */
export function PublishButton({ id, name, disabled }: { id: string; name: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}><Rocket aria-hidden />{disabled ? "Published" : "Publish"}</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent title={`Publish “${name}”?`} description="Sends and automations that use this template switch to the new version immediately." confirmLabel="Publish" destructive={false}
          onConfirm={() => { const f = document.getElementById(`publish-${id}`) as HTMLFormElement | null; f?.requestSubmit(); }} />
      </AlertDialog>
      <form id={`publish-${id}`} action={publishTemplate} hidden><input type="hidden" name="id" value={id} /></form>
    </>
  );
}
