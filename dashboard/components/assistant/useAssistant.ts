"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApplyResult, ChatEvent, ChatMsg, DoneStats, Phase, Proposal } from "@/lib/assistant/types";

export type Step = { id: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string };
export type CardState = "pending" | "applying" | "applied" | "failed" | "cancelled";
export type Card = { proposal: Proposal; state: CardState; result?: ApplyResult };
export type Msg = {
  id: string; role: "user" | "assistant"; text: string; steps: Step[]; cards: Card[];
  error?: { code: string; message: string; hint?: string }; stats?: DoneStats; stopped?: boolean;
};
export type Status = { configured: boolean; model?: { chain?: string[]; source?: string; error?: { message: string; hint: string } }; key?: { is_free_tier?: boolean; usage?: number; limit_remaining?: number | null; error?: string }; requests_today?: number };

const STORE = "mailcraft.assistant.v1";
const uid = () => Math.random().toString(36).slice(2, 10);

/** Folds one stream event into the assistant message it belongs to (pure: unit-tested). */
export function reduce(m: Msg, e: ChatEvent): Msg {
  switch (e.type) {
    case "text": return { ...m, text: m.text + e.delta };
    case "tool": {
      const s: Step = { id: e.id, name: e.name, label: e.label, status: e.status, detail: e.detail };
      return { ...m, steps: m.steps.some((x) => x.id === e.id) ? m.steps.map((x) => (x.id === e.id ? s : x)) : [...m.steps, s] };
    }
    case "proposal": return { ...m, cards: [...m.cards, { proposal: e.proposal, state: "pending" }] };
    case "error": return { ...m, error: { code: e.code, message: e.message, hint: e.hint } };
    case "done": return { ...m, stats: e.stats };
    default: return m;
  }
}

/** What the server sees of earlier turns: text plus a one-line note of tools used and changes applied (never raw tool output). */
export function toHistory(msgs: Msg[]): ChatMsg[] {
  return msgs.map((m) => {
    const notes = [
      m.steps.length ? `tools: ${m.steps.map((s) => s.label).slice(0, 6).join("; ")}` : "",
      ...m.cards.map((c) => {
        const t = c.proposal.title, redo = c.proposal.pending ? ` (once a person approves go-live, prepare it again: ${c.proposal.pending.what})` : "";
        return c.state === "applied" ? `applied: ${t}${redo}` : c.state === "cancelled" ? `cancelled: ${t}` : c.state === "pending" ? `proposed (not applied): ${t}${redo}` : "";
      }),
    ].filter(Boolean).join("; ");
    return { role: m.role, content: m.text, ...(notes && { note: notes }) };
  });
}

const load = (): Msg[] => { try { return JSON.parse(sessionStorage.getItem(STORE) ?? "[]"); } catch { return []; } };

export function useAssistant(path: string, onApplied?: () => void) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<{ phase: Phase; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const live = useRef(msgs);
  live.current = msgs;

  useEffect(() => { setMsgs(load().map((m) => ({ ...m, cards: m.cards.map((c) => (c.state === "applying" ? { ...c, state: "pending" as const } : c)) }))); }, []);
  useEffect(() => { if (!busy) try { sessionStorage.setItem(STORE, JSON.stringify(msgs)); } catch { /* storage full or blocked: keep working */ } }, [msgs, busy]);

  const patch = useCallback((id: string, f: (m: Msg) => Msg) => setMsgs((all) => all.map((m) => (m.id === id ? f(m) : m))), []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const user: Msg = { id: uid(), role: "user", text: t, steps: [], cards: [] };
    const bot: Msg = { id: uid(), role: "assistant", text: "", steps: [], cards: [] };
    const history = toHistory([...live.current, user]);
    setMsgs((all) => [...all, user, bot]);
    setBusy(true);
    setPhase({ phase: "thinking", label: "Thinking…" });
    const ac = (abort.current = new AbortController());
    try {
      const res = await fetch("/api/assistant", { method: "POST", signal: ac.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history, page: { path } }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        patch(bot.id, (m) => ({ ...m, error: { code: j.code ?? `http_${res.status}`, message: j.message ?? "The assistant is unavailable.", hint: j.hint } }));
        return;
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let e: ChatEvent;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "phase") setPhase({ phase: e.phase, label: e.label }); else patch(bot.id, (m) => reduce(m, e));
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") patch(bot.id, (m) => ({ ...m, stopped: true }));
      else patch(bot.id, (m) => ({ ...m, error: { code: "network", message: "Lost the connection to the dashboard server.", hint: "Check it is running and try again." } }));
    } finally {
      setBusy(false); setPhase(null); abort.current = null;
    }
  }, [busy, path, patch]);

  const stop = useCallback(() => abort.current?.abort(), []);
  const clear = useCallback(() => { abort.current?.abort(); setMsgs([]); try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } }, []);

  const setCard = (mid: string, pid: string, f: (c: Card) => Card) => patch(mid, (m) => ({ ...m, cards: m.cards.map((c) => (c.proposal.id === pid ? f(c) : c)) }));
  const post = (body: object) => fetch("/api/assistant/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const apply = useCallback(async (mid: string, pid: string, confirmed: boolean) => {
    setCard(mid, pid, (c) => ({ ...c, state: "applying" }));
    let result: ApplyResult;
    try { result = (await (await post({ id: pid, action: "apply", confirmed })).json()).result; } catch { result = { status: "failed", label: "Could not reach the server", error: { code: "network", message: "Could not reach the server." } }; }
    result ??= { status: "failed", label: "Not applied", error: { code: "unauthenticated", message: "Sign in again, then retry." } };
    setCard(mid, pid, (c) => ({ ...c, state: result.status === "failed" ? "failed" : "applied", result }));
    if (result.status !== "failed") onApplied?.();
  }, [onApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback((mid: string, pid: string) => {
    setCard(mid, pid, (c) => ({ ...c, state: "cancelled" }));
    void post({ id: pid, action: "cancel" }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { msgs, busy, phase, send, stop, clear, apply, cancel };
}

/** `/api/assistant/status` once per panel opening. */
export function useStatus(open: boolean) {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/assistant/status").then((r) => r.json()).then((j) => live && setS(j.configured === undefined ? null : j)).catch(() => {});
    return () => { live = false; };
  }, [open]);
  return s;
}
