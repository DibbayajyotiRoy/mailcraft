import { get, type ApiError } from "@/lib/api";
import { sendersOf } from "@/lib/senders";
import type { Options } from "./StepCard";

const list = (r: { data: unknown }): any[] => (Array.isArray(r.data) ? r.data : []);

/** What the pickers offer. Everything but templates degrades to "type it yourself" if its call fails. */
export async function loadOptions(): Promise<{ options: Options; error: ApiError | null }> {
  const [t, seg, ev, au, snd] = await Promise.all([get("/v1/templates"), get("/v1/segments"), get("/v1/events/names"), get("/v1/automations"), get("/v1/senders")]);
  const events = [...new Set([...list(ev).map((e) => e.name), ...list(au).map((a) => a.trigger_event)].filter((n): n is string => !!n && n !== "segment.entered"))];
  return {
    error: t.error,
    options: {
      templates: list(t).map((x) => ({ id: x.id, alias: x.alias ?? x.id, name: x.name ?? "", published: x.published_version != null })),
      segments: list(seg).map((x) => x.name).filter(Boolean),
      events,
      senders: sendersOf(snd),
    },
  };
}
