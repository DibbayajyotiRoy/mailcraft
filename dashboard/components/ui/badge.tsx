import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const TONE: Record<string, Tone> = {
  verified: "ok", delivered: "ok", sent: "ok", active: "ok", published: "ok", approved: "ok", pass: "ok", completed: "ok",
  pending: "warn", expired: "warn", deferred: "warn", draft: "warn", warn: "warn", paused: "warn", not_started: "warn",
  queued: "info", sending: "info", running: "info", pending_approval: "info",
  failed: "bad", bounced: "bad", complained: "bad", rejected: "bad", fail: "bad", cancelled: "bad", suppressed: "bad", revoked: "bad",
};
type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

/** What the status means, shown as the pill's tooltip. */
const MEANING: Record<string, string> = {
  bounced: "Recipient server rejected permanently", deferred: "Recipient server asked us to retry later", complained: "Recipient marked it as spam",
  suppressed: "Not sent: address is on the suppression list", pending_approval: "Waiting for a human to approve", not_started: "Verification has not started",
};

const pill = cva("inline-flex items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: { ok: "bg-ok-bg text-ok", warn: "bg-warn-bg text-warn", info: "bg-info-bg text-info", bad: "bg-bad-bg text-bad", neutral: "bg-surface-2 text-muted" },
    size: { sm: "h-5", md: "h-6" },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

export function Badge({ tone, size, className, children, ...p }: ComponentProps<"span"> & VariantProps<typeof pill>) {
  return <span className={cn(pill({ tone, size }), className)} {...p}>{children}</span>;
}

/** Colour is never the only signal: dot + the status text. The tone name is also a class (`tone-warn`) for tests/styling hooks. */
export function StatusBadge({ status, size, pulse }: { status: string; size?: "sm" | "md"; pulse?: boolean }) {
  const tone = TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} size={size} className={`tone-${tone}`} title={MEANING[status]}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", pulse && tone === "warn" && "animate-pulse-dot")} />
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
