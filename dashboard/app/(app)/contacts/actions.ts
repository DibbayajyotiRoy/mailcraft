"use server";
// Server actions for contacts and segments. Dialog forms return state (so they stay open on an error and keep
// what was typed); one-click destructive actions redirect with ?err= / ?ok= like the rest of the dashboard.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, type ApiError } from "@/lib/api";
import { withFlash } from "@/lib/flash";
import { EMAIL_RE, buildProps, type AttrRow, type AttrType } from "./attrs";
import type { PreviewRow } from "./ContactDiff";
import type { ImportRow } from "./csv";
import { parseEmails } from "./segmentRules";

const f = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const enc = encodeURIComponent;
const refresh = () => revalidatePath("/", "layout");
const bad = (message: string, field?: string, hint?: string): { error: ApiError } => ({ error: { code: "invalid_request", message, field, hint } });
/** Back to `from` with the API error in the query string (the page renders it). */
const back = (from: string, e: ApiError): never => redirect(`${from}${from.includes("?") ? "&" : "?"}err=${enc(`${e.code}|${e.message}|${e.hint ?? ""}`)}`);

export type FormState = { ok?: string; id?: string; error?: ApiError; attrErrors?: Record<number, string> };

// ------------------------------------------------------------------ contacts

export async function saveContact(_p: FormState, d: FormData): Promise<FormState> {
  const id = f(d, "id"), email = f(d, "email");
  const types = d.getAll("attr_type"), values = d.getAll("attr_value");
  const rows: AttrRow[] = d.getAll("attr_key").map((k, i) => ({ key: String(k), type: String(types[i]) as AttrType, value: String(values[i] ?? "") }));
  let initial: string[] = [];
  try { initial = JSON.parse(f(d, "initial_keys") || "[]"); } catch { /* none */ }
  const { props, errors } = buildProps(rows, id ? initial : []);
  if (Object.keys(errors).length) return { ...bad("Fix the attributes marked below."), attrErrors: errors };
  const first = f(d, "first_name"), last = f(d, "last_name"), tz = f(d, "timezone");
  if (id) {
    // PATCH: "" clears a field, null deletes a property.
    const r = await api("PATCH", `/v1/contacts/${enc(id)}`, { first_name: first, last_name: last, timezone: tz, properties: props });
    if (r.error) return { error: r.error };
    refresh();
    return { ok: `Saved ${r.data?.email ?? "contact"}`, id };
  }
  if (!EMAIL_RE.test(email)) return bad("Enter an email address like ana@example.com.", "email");
  // PUT would silently overwrite an existing contact; adding one should not.
  const have = await api("GET", `/v1/contacts/${enc(email)}`);
  if (have.data) return { error: { code: "already_exists", message: `${email} is already a contact.`, field: "email", hint: "Open it to change its details." }, id: have.data.id };
  if (have.error && have.error.code !== "not_found") return { error: have.error };
  const r = await api("PUT", "/v1/contacts", {
    email, first_name: first || undefined, last_name: last || undefined, timezone: tz || undefined,
    properties: Object.keys(props).length ? props : undefined,
  });
  if (r.error) return { error: r.error };
  refresh();
  return { ok: `Added ${r.data?.email ?? email}`, id: r.data?.id };
}

export async function deleteContact(d: FormData) {
  const id = f(d, "id"), r = await api("DELETE", `/v1/contacts/${enc(id)}`);
  if (r.error) back(`/contacts/${enc(id)}`, r.error);
  refresh();
  redirect(withFlash("/contacts", `Deleted ${f(d, "email")}`));
}

export async function suppressContact(d: FormData) {
  const id = f(d, "id"), to = `/contacts/${enc(id)}`, r = await api("POST", `/v1/contacts/${enc(id)}/suppress`, { reason: "manual" });
  if (r.error) back(to, r.error);
  refresh();
  redirect(withFlash(to, `Suppressed ${f(d, "email")}`));
}

export async function unsuppressContact(d: FormData) {
  const id = f(d, "id"), to = `/contacts/${enc(id)}`, r = await api("DELETE", `/v1/suppressions/${enc(f(d, "email"))}`);
  if (r.error) back(to, r.error);
  refresh();
  redirect(withFlash(to, `${f(d, "email")} can receive email again`));
}

export type TrackState = { error?: ApiError; result?: { dry: boolean; triggered: { id: string; name?: string }[]; inactive: { id: string; name: string; status: string }[]; duplicate?: boolean } };

export async function trackEvent(_p: TrackState, d: FormData): Promise<TrackState> {
  const name = f(d, "name"), text = f(d, "properties"), dry = d.get("dry_run") === "on";
  if (!name || name.length > 128) return bad("Event name must be 1-128 characters.", "name");
  let properties: unknown;
  if (text) {
    try { properties = JSON.parse(text); } catch { return bad("Properties are not valid JSON.", "properties"); }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return bad("Properties must be a JSON object, like {\"plan\":\"pro\"}.", "properties");
  }
  const r = await api("POST", "/v1/events", { name, contact: { email: f(d, "email") }, properties, dry_run: dry || undefined });
  if (r.error) return { error: r.error };
  if (!dry) refresh();
  return { result: { dry, triggered: r.data?.triggered_automations ?? [], inactive: r.data?.inactive_matches ?? [], duplicate: r.data?.duplicate } };
}

export type ImportResult = { imported: number; failed: { index: number; email: string; message: string }[]; error?: ApiError };
/** Where an import puts its contacts: an existing list, or a new one by display name (the server finds or creates it). */
export type ListTarget = { id?: string; name?: string } | null;
const targetBody = (t: ListTarget) => (t?.id ? { list_id: t.id } : t?.name ? { list_name: t.name } : {});

/** One chunk of an import (the dialog sends 500 at a time and shows progress). */
export async function importContactsChunk(contacts: ImportRow[], list: ListTarget = null): Promise<ImportResult> {
  const r = await api("POST", "/v1/contacts/import", { contacts, ...targetBody(list) });
  if (r.error) return { imported: 0, failed: [], error: r.error };
  refresh();
  return { imported: r.data.imported, failed: (r.data.failed ?? []).map((x: any) => ({ index: x.index, email: x.email, message: x.error?.message ?? "Rejected" })) };
}

export type PreviewChunk = { rows: PreviewRow[]; list: { id: string | null; name: string; exists: boolean } | null; error?: ApiError };

/** Dry run of one chunk: what each row would do (new / update / unchanged / skipped). Writes nothing, not even the list. */
export async function previewImportChunk(contacts: ImportRow[], list: ListTarget = null): Promise<PreviewChunk> {
  const r = await api("POST", "/v1/contacts/import", { contacts, dry_run: true, ...targetBody(list) });
  if (r.error) return { rows: [], list: null, error: r.error };
  return { rows: r.data.rows ?? [], list: r.data.list ?? null };
}

// ------------------------------------------------------------------ segments

export async function saveSegment(_p: FormState, d: FormData): Promise<FormState> {
  const id = f(d, "id"), name = f(d, "name"), text = f(d, "filter");
  if (!name) return bad("Give the segment a name.", "name");
  let filter: unknown = null;
  if (text) { try { filter = JSON.parse(text); } catch { return bad("The rules are not valid JSON.", "filter"); } }
  if (!id) { // POST upserts by name; creating should never overwrite another segment
    const all = await api("GET", "/v1/segments");
    if (all.data?.some((s: any) => s.name === name)) return bad(`A segment named “${name}” already exists.`, "name", "Pick another name, or edit that segment.");
  }
  const r = id ? await api("PUT", `/v1/segments/${enc(id)}`, { name, filter }) : await api("POST", "/v1/segments", { name, filter: filter ?? undefined });
  if (r.error) return { error: r.error };
  refresh();
  return { ok: id ? `Saved ${name}` : `Created ${name}`, id: r.data?.id };
}

export async function deleteSegment(d: FormData) {
  const r = await api("DELETE", `/v1/segments/${enc(f(d, "id"))}`);
  if (r.error) back("/contacts?tab=segments", r.error);
  refresh();
  redirect(withFlash("/contacts?tab=segments", `Deleted ${f(d, "name")}`));
}

export type Preview = { count: number; sample: { email: string; first_name?: string | null; last_name?: string | null }[]; error?: ApiError };

export async function previewSegment(filter: unknown): Promise<Preview> {
  const r = await api("POST", "/v1/segments/preview", { filter });
  return r.error ? { count: 0, sample: [], error: r.error } : { count: r.data.count, sample: r.data.sample ?? [] };
}

export async function addSegmentMembers(_p: FormState, d: FormData): Promise<FormState> {
  const { emails, bad: invalid } = parseEmails(String(d.get("emails") ?? ""));
  if (!emails.length) return bad("Enter at least one email address.", "emails");
  if (invalid.length) return bad(`Not an email address: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""}.`, "emails");
  let added = 0, already = 0;
  for (let i = 0; i < emails.length; i += 1000) {
    const r = await api("POST", `/v1/segments/${enc(f(d, "id"))}/members`, { emails: emails.slice(i, i + 1000) });
    if (r.error) return { error: r.error };
    added += r.data.added; already += r.data.already_members;
  }
  refresh();
  return { ok: `Added ${added}${already ? `, ${already} already in the segment` : ""}` };
}

// ------------------------------------------------------------------ lists

const names = (d: FormData) => ({ name: f(d, "name"), description: f(d, "description") });

/** Create (no id) or edit (id) a list: its display name and description. */
export async function saveList(_p: FormState, d: FormData): Promise<FormState> {
  const id = f(d, "id"), { name, description } = names(d);
  if (!name) return bad("Give the list a name.", "name");
  const r = id ? await api("PATCH", `/v1/lists/${enc(id)}`, { name, description }) : await api("POST", "/v1/lists", { name, description: description || undefined });
  if (r.error) return { error: r.error };
  refresh();
  return { ok: id ? `Saved ${name}` : `Created ${name}`, id: r.data?.id };
}

/** Deleting a list never deletes its contacts. */
export async function deleteList(d: FormData) {
  const r = await api("DELETE", `/v1/lists/${enc(f(d, "id"))}`);
  if (r.error) back("/contacts?tab=lists", r.error);
  refresh();
  redirect(withFlash("/contacts?tab=lists", `Deleted ${f(d, "name")}; its contacts are untouched`));
}

/** Add contacts (`id` fields) to an existing list (`list_id`) or to a new one (`new_name`). */
export async function addToList(_p: FormState, d: FormData): Promise<FormState> {
  const ids = d.getAll("id").map(String).filter(Boolean), newName = f(d, "new_name");
  let listId = f(d, "list_id"), label = f(d, "list_label");
  if (!ids.length) return bad("Pick at least one contact.");
  if (listId === "new" || (!listId && newName)) {
    if (!newName) return bad("Give the new list a name.", "new_name");
    const made = await api("POST", "/v1/lists", { name: newName });
    if (made.error) return { error: { ...made.error, field: made.error.field === "name" ? "new_name" : made.error.field } };
    listId = made.data.id; label = newName;
  }
  if (!listId) return bad("Pick a list.", "list_id");
  let added = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await api("POST", `/v1/lists/${enc(listId)}/members`, { contact_ids: ids.slice(i, i + 1000) });
    if (r.error) return { error: r.error };
    added += r.data.added;
  }
  refresh();
  return { ok: `Added ${added} ${added === 1 ? "contact" : "contacts"}${label ? ` to ${label}` : ""}`, id: listId };
}

/** Take contacts (`id` fields) off a list. The contacts stay. */
export async function removeFromList(_p: FormState, d: FormData): Promise<FormState> {
  const ids = d.getAll("id").map(String).filter(Boolean), listId = f(d, "list_id");
  let removed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await api("POST", `/v1/lists/${enc(listId)}/members/remove`, { contact_ids: ids.slice(i, i + 1000) });
    if (r.error) return { error: r.error };
    removed += r.data.removed;
  }
  refresh();
  return { ok: `Removed ${removed} ${removed === 1 ? "contact" : "contacts"} from ${f(d, "list_label") || "the list"}` };
}
