"use client";
import { useState } from "react";
import { revokeKey } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";

export function RevokeKey({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="danger-outline" onClick={() => setOpen(true)}>Revoke<span className="sr-only"> {name}</span></Button>
      <TypeNameConfirm open={open} onOpenChange={setOpen} title="Revoke API key"
        description="Anything using this key stops working immediately. This cannot be undone."
        expected={name} confirmLabel="Revoke key" action={revokeKey} fields={{ id, name }} />
    </>
  );
}
