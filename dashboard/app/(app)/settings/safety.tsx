import { Power, ShieldAlert } from "lucide-react";
import { setKill } from "@/lib/actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/Confirm";
import { cn } from "@/lib/cn";

/** Prominent, not buried: state first, consequence in plain words, engage asks first, release is admin-only. */
export function KillSwitchCard({ on, admin }: { on: boolean; admin: boolean }) {
  return (
    <Card id="kill-switch" aria-labelledby="kill-h" className={cn("scroll-mt-20", on && "border-bad")}>
      <CardHeader title={<span id="kill-h">Kill switch</span>} description="The emergency stop for all sending." />
      <CardBody className="grid gap-4">
        <div className={cn("flex items-start gap-3 rounded-md px-3 py-3", on ? "bg-bad-bg text-bad" : "bg-ok-bg text-ok")}>
          {on ? <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0" /> : <Power aria-hidden className="mt-0.5 size-5 shrink-0" />}
          <div className="text-sm">
            <p className="font-semibold">{on ? "Sending is paused" : "Sending is on"}</p>
            <p className="mt-0.5">{on
              ? "Nothing is leaving mailcraft. Queued emails wait and new sends are rejected until someone with an admin key releases it."
              : "Emails send normally. Engaging stops every send immediately, including queued emails and automations."}</p>
          </div>
        </div>
        <form action={setKill} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="from" value="/settings" />
          <input type="hidden" name="on" value={String(!on)} />
          {on
            ? <Button type="submit" disabled={!admin}>Release and resume sending</Button>
            : <ConfirmButton className="danger" title="Pause all sending?" message="Every send stops immediately: queued emails wait and new requests are rejected. Only an admin key can release it.">Pause all sending</ConfirmButton>}
          {on && !admin && <span className="text-sm text-muted">Releasing needs an admin key.</span>}
        </form>
      </CardBody>
    </Card>
  );
}
