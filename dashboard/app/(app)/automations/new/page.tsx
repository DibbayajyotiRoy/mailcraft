import Link from "next/link";
import { Mail, Sparkles, Hourglass, Plus } from "lucide-react";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";
import { RetryError } from "@/components/ui/error-state";
import { blankDraft, fromAutomation } from "../editor/model";
import { Editor } from "../editor/Editor";
import { loadOptions } from "../editor/options";
import { PRESETS, presetById } from "../editor/presets";

export const dynamic = "force-dynamic";
export const metadata = { title: "New automation" };

const ICON: Record<string, typeof Mail> = { blank: Plus, welcome: Mail, nudge: Hourglass, reengage: Sparkles };
const crumb = [{ label: "Automations", href: "/automations" }, { label: "New automation" }];

export default async function NewAutomation({ searchParams }: { searchParams: Promise<{ preset?: string; from?: string }> }) {
  const { preset, from } = await searchParams;
  if (!preset && !from) {
    return (
      <>
        <PageHeader breadcrumb={crumb} title="New automation" description="Start from an example, or build your own. Nothing sends until you publish." />
        <ul aria-label="Starting points" className="grid gap-3 sm:grid-cols-2">
          {[{ id: "blank", title: "Start from scratch", description: "An empty flow: pick the trigger and add your own steps." }, ...PRESETS].map((p) => {
            const Icon = ICON[p.id] ?? Mail;
            return (
              <li key={p.id}>
                <Link href={`/automations/new?preset=${p.id}`} className="group flex h-full gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2">
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Icon className="size-4" /></span>
                  <span className="min-w-0"><span className="block text-sm font-medium group-hover:underline">{p.title}</span><span className="mt-0.5 block text-sm text-muted">{p.description}</span></span>
                </Link>
              </li>
            );
          })}
        </ul>
      </>
    );
  }
  const [{ options, error }, src] = await Promise.all([loadOptions(), from ? get(`/v1/automations/${encodeURIComponent(from)}`) : null]);
  if (src?.error) return <><PageHeader breadcrumb={crumb} title="New automation" /><RetryError error={src.error} /></>;
  const initial = src ? { ...fromAutomation(src.data), name: `${src.data.name}-copy` } : (presetById(preset)?.build(options.templates.filter((t) => t.published).map((t) => t.alias)) ?? blankDraft());
  return (
    <>
      <PageHeader breadcrumb={crumb} title={src ? `Duplicate ${src.data.name}` : "New automation"} description={src ? "A copy to change. The original is untouched." : "Nothing sends until you publish."} />
      {error && <div className="mb-4"><RetryError error={error} /></div>}
      <Editor key={`${preset}-${from}`} mode="new" initial={initial} options={options} />
    </>
  );
}
