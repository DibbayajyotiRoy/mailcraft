"use client";
import { useState, type ComponentProps } from "react";
import { Input, Select } from "@/components/ui/field";
import { findSender, senderLabel, STATUS_LABEL, type Sender } from "@/lib/senders";

const OTHER = "\u0000other";

type Props = Omit<ComponentProps<"select">, "value" | "onChange"> & {
  senders?: Sender[]; value: string; onChange: (from: string) => void;
  /** Adds a first option with value "" (e.g. "First verified domain"). */
  emptyLabel?: string; placeholder?: string;
};

/** A From control: pick a connected address, or "Other address…" to type one on a verified domain.
 *  Native <select> + text input, so keyboard and screen readers get the platform behaviour for free.
 *  With no connected addresses it is just the text input. */
export function FromPicker({ senders = [], value, onChange, emptyLabel, placeholder = "you@yourdomain.com", ...a }: Props) {
  // typing mode: the value is not one of the connected addresses (or the user chose "Other")
  const [typing, setTyping] = useState(!!value && !findSender(senders, value));
  if (!senders.length) return <Input {...(a as object)} inputMode="email" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
  const known = findSender(senders, value);
  const sel = typing ? OTHER : known ? known.address : "";
  return (
    <div className="grid gap-2">
      <Select {...a} value={sel} onChange={(e) => {
        const v = e.target.value;
        setTyping(v === OTHER);
        onChange(v === OTHER ? "" : v);
      }}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : <option value="" disabled>Choose a sender</option>}
        {senders.map((s) => <option key={s.address} value={s.address}>{senderLabel(s)}{s.status && s.status !== "ready" ? ` (${STATUS_LABEL[s.status] ?? s.status})` : ""}</option>)}
        <option value={OTHER}>Other address…</option>
      </Select>
      {typing && <Input aria-label="Other From address" inputMode="email" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
    </div>
  );
}
