import { automationState } from "@/lib/actions";

/** active -> Disable (pause); anything else -> Enable (publish a draft, resume a paused one). */
export function StateButton({ id, status, from }: { id: string; status: string; from: string }) {
  const action = status === "active" ? "pause" : status === "paused" ? "resume" : "publish";
  return (
    <form action={automationState}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="action" value={action} /><input type="hidden" name="from" value={from} />
      <button type="submit">{status === "active" ? "Disable" : "Enable"}</button>
    </form>
  );
}
