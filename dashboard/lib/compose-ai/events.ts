// The wire contract of "Write with AI" in the New email dialog (no React, no server imports).
// POST /api/compose/write answers with NDJSON: one WriteEvent per line.
import type { Mode } from "@/lib/compose";

export type Tone = "friendly" | "short" | "formal";
export const TONES: Tone[] = ["friendly", "short", "formal"];

/** What the dialog sends. The server never takes a model from here (free models only), and reads the template itself. */
export type WriteRequest = {
  prompt: string; tone?: Tone; mode: Mode;
  template?: string;      // template id, template mode only; the server reads its variables, subject and source
  fromName?: string;      // sender display name, when known
  names?: string[];       // names of picked contacts (never their addresses)
  count?: number;         // how many recipients in total
};

/** `field` is "subject" | "text" | "html" | "var:<variable name>". A field's first delta replaces what was in the box; later deltas append. */
export type FieldEvent = { field: string; delta: string } | { field: string; done: true };
export type WriteUsage = { tokens: number; prompt: number; completion: number; ms: number; model: string; estimated?: boolean };
export type WriteEvent = FieldEvent | { done: true; usage: WriteUsage } | { error: { code: string; message: string; hint?: string; resetAt?: number } };

/** lib/compose-ai/fields.ts exports the tolerant streaming JSON reader the route uses:
 *    class FieldStream { push(chunk: string): FieldEvent[]; end(): FieldEvent[] }
 *  It reads ONE JSON object as the model streams it ({"subject":"…","text":"…"} or {"subject":"…","vars":{"first_name":"…"}}), and emits
 *  { field, delta } as each string value grows, then { field, done: true } when its closing quote arrives. Top-level keys keep their
 *  name; keys inside "vars" become "var:<key>". See the file for the full rules. */
export {};
