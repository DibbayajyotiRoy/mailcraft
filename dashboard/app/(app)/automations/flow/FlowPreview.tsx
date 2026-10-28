"use client";
import { useMemo } from "react";
import type { StepStat } from "../editor/StepStats";
import { buildFlow } from "./flow";
import { Flowchart } from "./Flowchart";
import { jumpToStep } from "./jump";

/** The editor's live preview: the draft's definition (the JSON it would save) drawn as a flowchart; a click jumps to that step's card. */
export function FlowPreview({ definition, stats }: { definition: string; stats?: Record<string, StepStat> | null }) {
  const graph = useMemo(() => (definition ? buildFlow(JSON.parse(definition), stats) : null), [definition, stats]);
  if (!graph) return <p role="status" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">The preview comes back once every rule is valid JSON.</p>;
  return <Flowchart graph={graph} label="Flow preview" onSelect={jumpToStep} />;
}
