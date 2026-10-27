import { automationState } from "@/lib/actions";
import { SubmitButton } from "@/components/ui/button";

/** active -> Disable (pause); anything else -> Enable (publish a draft, resume a paused one). */
export function StateButton({ id, status, from }: { id: string; status: string; from: string }) {
  const action = status === "active" ? "pause" : status === "paused" ? "resume" : "publish";
  return (
    <form action={automationState}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="action" value={action} /><input type="hidden" name="from" value={from} />
      <SubmitButton variant={status === "active" ? "secondary" : "primary"}>{status === "active" ? "Disable" : "Enable"}</SubmitButton>
    </form>
  );
}
