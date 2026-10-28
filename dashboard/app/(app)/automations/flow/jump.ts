/** Scroll to a step's card (the editor's `#step-<key>` article, the step list's `<li id="step-<key>">`) and move focus there. */
export function jumpToStep(key: string) {
  const el = document.getElementById(`step-${key}`);
  if (!el) return;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}
