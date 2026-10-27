"use client";
import { useState, useTransition } from "react";
import { automationState } from "@/lib/actions";
import { AlertDialog, AlertDialogContent } from "@/components/ui/dialog";
import { Switch } from "./Switch";

export type AutomationAction = "publish" | "pause" | "resume";

/** The state machine: active -> pause; paused -> resume; draft (anything else) -> publish. */
export const nextAction = (status: string): AutomationAction => (status === "active" ? "pause" : status === "paused" ? "resume" : "publish");

const COPY: Record<AutomationAction, { title: (n: string) => string; body: string; confirm: string }> = {
  publish: { title: (n) => `Publish “${n}”?`, body: "The automation goes live: contacts matching its trigger start receiving emails. Its first sends may wait for approval.", confirm: "Publish" },
  pause: { title: (n) => `Pause “${n}”?`, body: "New contacts stop entering while it is paused. You can resume it at any time.", confirm: "Pause" },
  resume: { title: (n) => `Resume “${n}”?`, body: "New contacts matching the trigger enter again.", confirm: "Resume" },
};

/** Switch = "is this automation live". Toggling never changes state directly: it asks first, then calls the `automationState` server action. */
export function AutomationToggle({ id, name, status, from }: { id: string; name: string; status: string; from: string }) {
  const [ask, setAsk] = useState<AutomationAction | null>(null);
  const [pending, start] = useTransition();
  const action = nextAction(status);
  const c = COPY[action];
  function confirm() {
    const fd = new FormData();
    fd.set("id", id); fd.set("action", action); fd.set("from", from);
    start(async () => { await automationState(fd); });
  }
  return (
    <>
      <Switch checked={status === "active"} disabled={pending} aria-busy={pending || undefined}
        aria-label={`${name}: ${status === "active" ? "live, switch off to pause" : status === "paused" ? "paused, switch on to resume" : "draft, switch on to publish"}`}
        onCheckedChange={() => setAsk(action)} />
      <AlertDialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent title={c.title(name)} description={c.body} confirmLabel={c.confirm} destructive={false} onConfirm={confirm} />
      </AlertDialog>
    </>
  );
}
