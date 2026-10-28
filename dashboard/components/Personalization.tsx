"use client";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { EXAMPLE, PERSONALIZATION, TIPS } from "@/lib/personalization";

/** Info button that opens the syntax for dynamic values (merge fields), each with a copy button. */
export function Personalization({ label = "Personalization" }: { label?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="secondary" size="sm"><Info aria-hidden />{label}</Button></DialogTrigger>
      <DialogContent title="Personalization" description="Put dynamic values in the subject and body. Copy a snippet and paste it where you want it." className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto">
        <div className="grid gap-5">
          <section aria-labelledby="pz-ex" className="grid gap-1.5">
            <h3 id="pz-ex" className="text-sm font-medium">Example</h3>
            <CopyField value={EXAMPLE} label="example sentence" wrap />
          </section>
          {PERSONALIZATION.map((g, i) => (
            <section key={g.group} aria-labelledby={`pz-${i}`} className="grid gap-2">
              <div>
                <h3 id={`pz-${i}`} className="text-sm font-medium">{g.group}</h3>
                {g.note && <p className="text-xs text-muted">{g.note}</p>}
              </div>
              <ul className="grid gap-3">
                {g.items.map((s) => (
                  <li key={s.code} className="grid gap-1">
                    <CopyField value={s.code} label={s.code} wrap />
                    <p className="text-xs text-muted">{s.what}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <ul className="grid list-disc gap-1.5 pl-5 text-xs text-muted">{TIPS.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
