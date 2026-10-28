"use client";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmButton } from "@/components/Confirm";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TypeNameConfirm } from "@/components/ui/type-name-confirm";
import { deleteContact, suppressContact, unsuppressContact } from "./actions";
import type { Contact } from "./util";

const WARN: Record<string, string> = {
  hard_bounce: "It was suppressed after a hard bounce: the address does not accept mail.",
  soft_bounce_limit: "It was suppressed after repeated soft bounces.",
  complaint: "It was suppressed after the recipient marked a message as spam.",
  unsubscribe: "It was suppressed because the recipient unsubscribed.",
  spam_trap: "It was suppressed as a suspected spam trap.",
  source_deleted: "It was suppressed because the account was deleted at the contact source it came from.",
  source_suspended: "It was suppressed because the account is suspended at the contact source it came from.",
};

/** Suppress / unsuppress and delete. Each asks first; delete also needs the email typed. */
export function DangerZone({ contact: c, suppressed, reason }: { contact: Contact; suppressed: boolean; reason?: string | null }) {
  const [del, setDel] = useState(false);
  const ids = <><input type="hidden" name="id" value={c.id} /><input type="hidden" name="email" value={c.email} /></>;
  return (
    <Card>
      <CardHeader title="Danger zone" />
      <CardBody className="grid gap-5">
        <div className="grid gap-2">
          <p className="text-sm font-medium">{suppressed ? "Allow email again" : "Stop sending"}</p>
          <p className="text-sm text-muted">
            {suppressed
              ? <>Removes {c.email} from the suppression list. {reason && WARN[reason]} Sending to it again can hurt your sender reputation.</>
              : <>Adds {c.email} to the suppression list. Nothing is sent to it, from any automation or API call, until you allow it again.</>}
          </p>
          <form action={suppressed ? unsuppressContact : suppressContact}>
            {ids}
            {suppressed
              ? <ConfirmButton title="Allow email to this address?" message={`${c.email} will be able to receive email again.${reason && WARN[reason] ? ` ${WARN[reason]}` : ""}`}>Remove suppression</ConfirmButton>
              : <ConfirmButton className="danger" title="Suppress this address?" message={`Nothing will be sent to ${c.email} until you remove the suppression.`}>Suppress</ConfirmButton>}
          </form>
        </div>
        <div className="grid gap-2 border-t border-border pt-5">
          <p className="text-sm font-medium">Delete contact</p>
          <p className="text-sm text-muted">Removes the contact, its events and automation runs. Emails already sent stay in the log. A suppression on the address is kept.</p>
          <div><Button variant="danger-outline" onClick={() => setDel(true)}><Trash2 aria-hidden />Delete contact</Button></div>
        </div>
      </CardBody>
      <TypeNameConfirm open={del} onOpenChange={setDel} title="Delete this contact?" expected={c.email} confirmLabel="Delete contact"
        description={<>This permanently deletes <strong>{c.email}</strong> and its history. This cannot be undone.</>}
        action={deleteContact} fields={{ id: c.id!, email: c.email }} />
    </Card>
  );
}
