// One-click starting points. Each builds a complete draft; the template is picked from what the workspace has
// published (matching by name hints) and is left empty, so validation points at it, when nothing fits.
import { blankDraft, makeStep, type Draft, type EStep } from "./model";

export type Preset = { id: string; title: string; description: string; build: (published: string[]) => Draft };

const pick = (published: string[], hints: RegExp) => published.find((a) => hints.test(a)) ?? "";

function withSteps(d: Draft, build: (add: (type: EStep["type"], config?: Record<string, any>, edges?: Record<string, string>) => void) => void): Draft {
  const out = { ...d, steps: [] as EStep[] };
  build((type, config, edges) => {
    const s = makeStep(out, type, config);
    out.steps.push({ ...s, edges: { ...s.edges, ...edges } });
  });
  return out;
}

export const PRESETS: Preset[] = [
  {
    id: "welcome", title: "Welcome after signup", description: "Send one welcome email as soon as someone signs up.",
    build: (published) => withSteps({ ...blankDraft(), name: "welcome", trigger: { kind: "event", events: "signed_up", segment: "", filter: null } }, (add) => {
      add("send_email", { template: pick(published, /welcome|hello|onboard/i), mode: "static" });
    }),
  },
  {
    id: "nudge", title: "Onboarding nudge after 3 days", description: "Wait three days for activation. If it never happens, send a nudge.",
    build: (published) => withSteps({ ...blankDraft(), name: "onboarding-nudge", trigger: { kind: "event", events: "signed_up", segment: "", filter: null } }, (add) => {
      add("wait_for_event", { event: "activated", timeout: "3d" }, { event: "end", timeout: "next" });
      add("send_email", { template: pick(published, /nudge|onboard|tips|getting.?started/i), mode: "static" });
    }),
  },
  {
    id: "reengage", title: "Re-engage after inactivity", description: "After 14 days without a login, send a win-back email and tag the contact as lapsed.",
    build: (published) => withSteps({ ...blankDraft(), name: "re-engage", entry_rule: "always", trigger: { kind: "event", events: "logged_in", segment: "", filter: null } }, (add) => {
      add("wait_for_event", { event: "logged_in", timeout: "14d" }, { event: "end", timeout: "next" });
      add("send_email", { template: pick(published, /win.?back|re.?engage|miss/i), mode: "static", stream: "marketing" });
      add("add_to_segment", { segment: "lapsed" });
    }),
  },
];

export const presetById = (id: string | undefined) => PRESETS.find((p) => p.id === id);
