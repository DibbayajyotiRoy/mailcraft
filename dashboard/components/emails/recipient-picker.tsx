"use client";
import { TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { isEmail } from "@/lib/compose";
import { addRecipients, contactName, isSuppressed, splitAddresses, type ContactHit, type Recipient } from "@/lib/recipients";

/** One row in the suggestion list: a contact, or (no `hit`) "use the address as typed". */
type Opt = { key: string; email: string; hit?: ContactHit };

type Props = {
  id: string; "aria-describedby"?: string; "aria-invalid"?: true;
  recipients: Recipient[]; onRecipients: (r: Recipient[]) => void;
  draft: string; onDraft: (s: string) => void;
  /** Without it the field is a plain chip input. */
  search?: (q: string) => Promise<ContactHit[]>;
};

/** To field as a combobox: chips for the chosen recipients, and contact suggestions while you type (debounced 250ms).
 *  Arrow keys move, Enter or Tab picks, Esc closes the list (not the dialog). Comma, Enter or leaving a complete
 *  address turns the text into a chip; pasting several addresses makes one chip each. */
export function RecipientPicker({ recipients, onRecipients, draft, onDraft, search, id, ...aria }: Props) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [done, setDone] = useState(""); // the text the hits are the answer for
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const q = draft.trim();
    if (!search || !q) { setHits([]); setDone(""); return; }
    let stale = false;
    const t = setTimeout(() => {
      search(q).then((h) => { if (!stale) { setHits(h); setDone(q); setActive(-1); } }).catch(() => { if (!stale) { setHits([]); setDone(q); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [draft, search]);

  const have = new Set(recipients.map((r) => r.email.toLowerCase()));
  const shown = hits.filter((h) => !have.has(h.email.toLowerCase()));
  const q = draft.trim();
  const useTyped = !!search && done === q && isEmail(q) && !have.has(q.toLowerCase()) && !shown.some((h) => h.email.toLowerCase() === q.toLowerCase());
  const opts: Opt[] = [...shown.map((h) => ({ key: h.id ?? h.email, email: h.email, hit: h })), ...(useTyped ? [{ key: "typed", email: q }] : [])];
  const showList = open && opts.length > 0;
  const current = showList && active >= 0 ? opts[active] : undefined;

  // Radix closes the dialog on Esc from a capture listener on document; this one runs first (window capture) and keeps Esc for the open list.
  useEffect(() => {
    if (!showList) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setActive(-1); } };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [showList]);

  const commit = (text: string) => {
    const parts = splitAddresses(text);
    if (parts.length) onRecipients(addRecipients(recipients, parts, hits));
    onDraft(""); setOpen(false); setActive(-1);
  };
  const pick = (o: Opt) => {
    onRecipients(addRecipients(recipients, [o.email], o.hit ? [o.hit] : []));
    onDraft(""); setOpen(false); setActive(-1);
    input.current?.focus();
  };

  function onChange(v: string) {
    setOpen(true);
    if (!/[,;\n]/.test(v)) return onDraft(v);
    const parts = v.split(/[,;\n]/), tail = parts.pop() ?? ""; // everything before the last separator is done; the rest is still being typed
    onRecipients(addRecipients(recipients, splitAddresses(parts.join(",")), hits));
    onDraft(tail.trimStart());
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const t = e.clipboardData.getData("text");
    if (!/[,;\n]/.test(t) && splitAddresses(t).length < 2) return; // one address or a name: ordinary paste
    e.preventDefault();
    commit([draft, t].filter(Boolean).join(","));
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && opts.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % opts.length : i <= 0 ? opts.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault(); // Enter here adds a recipient; it never sends the email
      if (current) pick(current); else commit(draft);
    } else if (e.key === "Tab") {
      if (current) { e.preventDefault(); pick(current); } else if (isEmail(q)) commit(draft); // leaving with a half-typed name keeps it as text
    } else if ((e.key === "," || e.key === ";") && q) {
      e.preventDefault(); commit(draft);
    } else if (e.key === "Backspace" && !draft && recipients.length) {
      onRecipients(recipients.slice(0, -1));
    }
  }

  return (
    <div className="relative">
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a bigger click target for the input inside; keyboard users reach it directly */}
      <div onClick={() => input.current?.focus()}
        className="flex min-h-8 w-full cursor-text flex-wrap items-center gap-1.5 rounded-sm border border-input bg-bg px-2 py-1 transition-[border-color,box-shadow] duration-[var(--dur-fast)] has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-[color:var(--ring,var(--accent))] has-[[aria-invalid=true]]:border-bad">
        {recipients.map((r) => {
          const invalid = !isEmail(r.email), sup = isSuppressed(r.contact), name = r.contact ? contactName(r.contact) : "";
          return (
            <span key={r.email} title={name || undefined}
              className={cn("inline-flex h-6 max-w-full items-center gap-1 rounded-sm border pl-2 text-xs", invalid ? "border-bad/50 bg-bad-bg text-bad" : sup ? "border-warn/40 bg-warn-bg text-warn" : "border-border bg-surface-2 text-fg")}>
              {(invalid || sup) && <TriangleAlert aria-hidden className="size-3 shrink-0" />}
              <span className="truncate">{r.email}</span>
              {invalid && <span className="sr-only">(not an email address)</span>}
              {sup && <span className="font-medium">Suppressed</span>}
              <button type="button" aria-label={`Remove ${r.email}`} onClick={() => { onRecipients(recipients.filter((x) => x !== r)); input.current?.focus(); }}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-fg/10"><X aria-hidden className="size-3" /></button>
            </span>
          );
        })}
        <input ref={input} id={id} {...aria} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={current ? `${listId}-${active}` : undefined}
          autoComplete="off" spellCheck={false} value={draft} placeholder={recipients.length ? "" : "Name or address, e.g. ada@example.com"}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); if (isEmail(q)) commit(draft); }}
          className="h-6 min-w-[11rem] flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-subtle sm:text-sm" />
      </div>
      <ul id={listId} role="listbox" aria-label="Matching contacts" hidden={!showList}
        className="absolute inset-x-0 top-full z-20 mt-1 rounded-md border border-border bg-bg p-1 shadow-pop">
        {opts.map((o, i) => {
          const name = o.hit ? contactName(o.hit) : "";
          return (
            <li key={o.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseMove={() => setActive(i)}
              className={cn("flex min-h-8 cursor-pointer flex-wrap items-center gap-x-2 rounded-sm px-2 py-1 text-sm", i === active && "bg-surface-2")}>
              {o.hit ? (
                <>
                  {name && <span className="font-medium">{name}</span>}
                  <span className={name ? "text-muted" : "font-medium"}>{o.email}</span>
                  {isSuppressed(o.hit) && <span className="ml-auto text-xs font-medium text-warn">Suppressed</span>}
                </>
              ) : (
                <><span>Use <span className="font-medium">{o.email}</span></span><span className="text-xs text-muted">not in your contacts yet</span></>
              )}
            </li>
          );
        })}
      </ul>
      <div role="status" className="sr-only">{showList ? `${shown.length} matching ${shown.length === 1 ? "contact" : "contacts"}` : ""}</div>
    </div>
  );
}
