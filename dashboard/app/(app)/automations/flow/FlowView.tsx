"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { StepStat } from "../editor/StepStats";
import { buildFlow } from "./flow";
import { Flowchart } from "./Flowchart";
import { jumpToStep } from "./jump";

type View = "flow" | "steps";
const KEY = "mc_automation_view";

const stored = (): View | null => {
  try { const v = localStorage.getItem(KEY); return v === "flow" || v === "steps" ? v : null; } catch { return null; }
};

/**
 * The detail page's Flow tab: the flowchart or the step list (`steps`, rendered on the server), one at a time.
 * No saved choice: the flowchart from 1024px up, the list below. Until the page hydrates both are in the markup and CSS
 * picks one, so there is no flash; afterwards only the chosen one is mounted. A step clicked in the chart opens in the list.
 */
export function FlowView({ automation, stats, steps }: { automation: unknown; stats: Record<string, StepStat> | null; steps: ReactNode }) {
  const graph = useMemo(() => buildFlow(automation, stats), [automation, stats]);
  const [view, setView] = useState<View | null>(null), [target, setTarget] = useState<string | null>(null);

  useEffect(() => { setView(stored() ?? (window.matchMedia?.("(min-width: 1024px)").matches === false ? "steps" : "flow")); }, []);
  useEffect(() => { if (view === "steps" && target) { jumpToStep(target); setTarget(null); } }, [view, target]);

  const choose = (v: View) => { setView(v); try { localStorage.setItem(KEY, v); } catch { /* private mode: the choice lasts for this visit */ } };
  const pre = view === null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {view !== "steps" && <p className={pre ? "text-sm text-muted max-lg:hidden" : "text-sm text-muted"}>Select a step to open its details in the step list.</p>}
        <SegmentedControl label="Show the automation as" value={view ?? "flow"} onValueChange={choose} className="ml-auto"
          options={[{ value: "flow", label: "Flow" }, { value: "steps", label: "Steps" }]} />
      </div>
      {(pre || view === "flow") && <div className={pre ? "max-lg:hidden" : undefined}><Flowchart graph={graph} onSelect={(key) => { setView("steps"); setTarget(key); }} /></div>}
      {(pre || view === "steps") && <div className={pre ? "lg:hidden" : undefined}>{steps}</div>}
    </div>
  );
}
