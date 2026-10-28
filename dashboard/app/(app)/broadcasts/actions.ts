"use server";
import { revalidatePath } from "next/cache";
import { api, type ApiError } from "@/lib/api";
import type { Recipient } from "@/lib/csv";

export type Draft = { template_id: string; from: string; subject?: string; stream: "marketing" | "transactional"; max_per_day?: number };
export type Out<T = any> = { data?: T; error?: ApiError };

const clean = (d: Draft) => ({ template_id: d.template_id, from: d.from.trim(), stream: d.stream, ...(d.subject?.trim() && { subject: d.subject.trim() }) });

/** One recipient rendered exactly as the worker will (POST /v1/broadcasts/preview). */
export async function previewBroadcast(d: Draft, recipient: Recipient): Promise<Out<{ subject: string; html: string; text: string }>> {
  const { max_per_day: _m, ...rest } = clean(d) as ReturnType<typeof clean> & { max_per_day?: number };
  const r = await api("POST", "/v1/broadcasts/preview", { ...rest, recipient });
  return r.error ? { error: r.error } : { data: r.data };
}

/** `dryRun` validates, screens and schedules without queueing anything (the Review step). A long timeout: up to 5000 rows are written. */
export async function createBroadcast(d: Draft, recipients: Recipient[], dryRun: boolean): Promise<Out> {
  const r = await api("POST", "/v1/broadcasts", { ...clean(d), recipients, ...(d.max_per_day ? { max_per_day: d.max_per_day } : {}), dry_run: dryRun }, 120_000);
  if (r.error) return { error: r.error };
  if (!dryRun) revalidatePath("/broadcasts");
  return { data: r.data };
}
