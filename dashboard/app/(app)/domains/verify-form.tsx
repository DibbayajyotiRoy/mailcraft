"use client";
import { RefreshCw } from "lucide-react";
import { useFormStatus } from "react-dom";
import { verifyDomain } from "@/lib/actions";
import { Busy } from "@/components/ui/busy";
import { SubmitButton } from "@/components/ui/button";

function Status() {
  const { pending } = useFormStatus();
  return <span role="status" className={pending ? undefined : "sr-only"}>{pending && <Busy state="searching" label="Checking DNS…" />}</span>;
}

/** Prominent Verify action: searching orb + live "Checking DNS…" while the server action runs; result arrives as a flash toast. */
export function VerifyForm({ id, name, primary }: { id: string; name: string; primary: boolean }) {
  return (
    <form action={verifyDomain} className="flex items-center gap-3">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="name" value={name} />
      <Status />
      <SubmitButton size="lg" variant={primary ? "primary" : "secondary"}><RefreshCw aria-hidden />Verify now<span className="sr-only"> {name}</span></SubmitButton>
    </form>
  );
}
