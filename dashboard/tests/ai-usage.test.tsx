import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ keyInfo: vi.fn(), requestsToday: vi.fn(), freeToday: vi.fn(), allowedModels: vi.fn() }));
vi.mock("@/lib/assistant/usage", () => ({ keyInfo: h.keyInfo, requestsToday: h.requestsToday, freeToday: h.freeToday }));
// The real resolveModels stays, so a paid pin is rejected with the real message; only the network-backed allowlist is replaced.
vi.mock("@/lib/assistant/models", async (orig) => ({ ...(await orig<typeof import("@/lib/assistant/models")>()), allowedModels: h.allowedModels }));

import { AiUsageCard, EMAIL_DEFAULT_MODEL } from "@/app/(app)/settings/ai-usage";

const ALLOWED = { ids: ["a/one:free", "b/two:free", "c/three:free", "d/four:free"], source: "openrouter" as const };
const ok = (data: Record<string, unknown>) => ({ ok: true as const, data });
const renderCard = async (emailModel?: string | null) => render(await AiUsageCard({ emailModel }));
/** The <dd> next to the <dt> with this label in the key list. */
const dd = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const noRow = (label: string) => expect(screen.queryByText(label, { selector: "dt" })).toBeNull();

beforeEach(() => {
  h.keyInfo.mockResolvedValue(ok({ label: "mailcraft-prod" }));
  h.requestsToday.mockReturnValue(0);
  h.freeToday.mockReturnValue(null);
  h.allowedModels.mockResolvedValue(ALLOWED);
  vi.stubEnv("MAILCRAFT_ASSISTANT_MODEL", "");
  vi.stubEnv("MAILCRAFT_LLM_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("OpenRouter key", () => {
  it("shows the fields exactly as OpenRouter returned them, nothing rounded or invented", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-secret-value");
    h.keyInfo.mockResolvedValue(ok({ label: "mailcraft-prod", usage: 12.3456, limit: null, limit_remaining: 87.6544, is_free_tier: false }));
    const { container } = await renderCard();
    expect(dd("Key").textContent).toMatch(/^mailcraft-prod$/);
    expect(dd("Credits used").textContent).toMatch(/^12\.3456$/);
    expect(dd("Credit limit").textContent).toMatch(/^none$/); // null stays "none", not 0
    expect(dd("Credit limit left").textContent).toMatch(/^87\.6544$/); // spend, so it is not called "Remaining"
    expect(dd("Free tier").textContent).toMatch(/^no$/);
    noRow("Credits used today"); // fields OpenRouter did not send are not shown
    expect(container.innerHTML).not.toContain("sk-or-v1-secret-value"); // the key itself never reaches the page
    expect(screen.getByText("This key has credits, but mailcraft still only calls free models.")).toBeTruthy();
  });

  it("keeps zero and true as real values", async () => {
    h.keyInfo.mockResolvedValue(ok({ usage: 0, limit_remaining: 0, is_free_tier: true }));
    await renderCard();
    expect(dd("Credits used").textContent).toMatch(/^0$/);
    expect(dd("Credit limit left").textContent).toMatch(/^0$/);
    expect(dd("Free tier").textContent).toMatch(/^yes$/);
    expect(screen.getByText(/Free models have a small allowance of requests/)).toBeTruthy();
  });

  it("hides the deprecated rate_limit that OpenRouter reports as requests: -1", async () => {
    h.keyInfo.mockResolvedValue(ok({ label: "k", rate_limit: { requests: -1, interval: "10s" } }));
    const { container } = await renderCard();
    noRow("Rate limit");
    noRow("rate_limit");
    expect(container.textContent).not.toContain("-1");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("shows a real rate_limit as one row", async () => {
    h.keyInfo.mockResolvedValue(ok({ rate_limit: { requests: 20, interval: "1m" } }));
    await renderCard();
    expect(dd("Rate limit").textContent).toMatch("20 requests per 1m");
    noRow("rate_limit");
  });

  it("no free-request count from OpenRouter: this dashboard's own tally, approximate, with the UTC reset", async () => {
    h.requestsToday.mockReturnValue(7);
    await renderCard();
    const row = dd("Requests today");
    expect(row.textContent).toMatch(/^~7 /);
    expect(row.textContent).toMatch(/local tally, approximate/);
    expect(row.textContent).toMatch(/since midnight UTC/);
    expect(row.textContent).toMatch(/resets \d/);
    noRow("Free requests today");
    expect(screen.getByText(/OpenRouter has not reported the free requests left/)).toBeTruthy();
  });

  it("OpenRouter's free-request count replaces the tally, with the reset time", async () => {
    h.requestsToday.mockReturnValue(7);
    h.freeToday.mockReturnValue({ limit: 50, remaining: 0, resetAt: Date.now() + 3 * 3_600_000, source: "headers" });
    h.keyInfo.mockResolvedValue(ok({ label: "k", limit: null, limit_remaining: 50, is_free_tier: true }));
    await renderCard();
    const row = dd("Free requests today");
    expect(row.textContent).toMatch(/^0 of 50 left/);
    expect(row.textContent).toMatch(/from OpenRouter/);
    expect(row.textContent).toMatch(/resets \d.* · in 3h/);
    noRow("Requests today"); // one count, not two that disagree
    expect(dd("Credit limit left").textContent).toMatch(/^50$/); // the 50 credits are spend, a different thing from the 0 free requests
    expect(screen.queryByText(/OpenRouter has not reported/)).toBeNull();
  });

  it("the key's free-request counter object is never dumped as a generic row, and a null credit-limit-left is hidden", async () => {
    h.keyInfo.mockResolvedValue(ok({ label: "k", limit: null, limit_remaining: null, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } }));
    const { container } = await renderCard();
    noRow("free_model_daily_requests");
    noRow("Credit limit left");
    expect(dd("Credit limit").textContent).toBe("none");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("a missing key shows the hint to set OPENROUTER_API_KEY, and no key rows", async () => {
    h.keyInfo.mockResolvedValue({ ok: false, reason: "no_key", message: "OPENROUTER_API_KEY is not set on the dashboard server." });
    const { container } = await renderCard();
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch("OPENROUTER_API_KEY is not set on the dashboard server.");
    expect(status.textContent).toMatch(/Set OPENROUTER_API_KEY on the dashboard server and restart it; a free key is enough\./);
    expect(within(status).getByText("OPENROUTER_API_KEY", { selector: "code" })).toBeTruthy();
    expect(container.querySelector("dl")).toBeNull();
  });

  it("a 401 shows its message and no set-the-key hint", async () => {
    const message = "OpenRouter rejected the key (401). Check OPENROUTER_API_KEY.";
    h.keyInfo.mockResolvedValue({ ok: false, reason: "unauthorized", message });
    const { container } = await renderCard();
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(message);
    expect(status.textContent).not.toMatch("restart it");
    expect(within(status).queryByText("OPENROUTER_API_KEY", { selector: "code" })).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
  });
});

describe("Models", () => {
  it("lists the first three of the chain, free, first choice then fallbacks", async () => {
    await renderCard();
    const items = screen.getAllByRole("listitem");
    expect(items.slice(0, 3).map((li) => li.querySelector("code")?.textContent)).toEqual(["a/one:free", "b/two:free", "c/three:free"]);
    expect(items[0].textContent).toMatch("first choice");
    expect(items[1].textContent).toMatch("fallback");
    expect(screen.queryByText("d/four:free")).toBeNull();
    expect(screen.getByText(/Allowed set: 4 models/)).toBeTruthy();
    expect(screen.getByText("Assistant (fastest healthy first)")).toBeTruthy();
  });

  it("says so when OpenRouter's list could not be fetched", async () => {
    h.allowedModels.mockResolvedValue({ ...ALLOWED, source: "builtin" });
    await renderCard();
    expect(screen.getByText(/could not be fetched; using the built-in free list/)).toBeTruthy();
  });

  it("a paid MAILCRAFT_ASSISTANT_MODEL shows the rejection alert instead of a model list", async () => {
    vi.stubEnv("MAILCRAFT_ASSISTANT_MODEL", "deepseek/deepseek-v4-flash");
    await renderCard();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch('MAILCRAFT_ASSISTANT_MODEL "deepseek/deepseek-v4-flash" is not an allowed model.');
    expect(alert.textContent).toMatch("Unset it or pick one, e.g. a/one:free.");
    expect(screen.queryByText("first choice")).toBeNull();
    expect(screen.queryByText("a/one:free", { selector: "code" })).toBeNull(); // no chain is shown, so nothing is silently substituted
  });

  it("a free MAILCRAFT_ASSISTANT_MODEL is labelled as pinned and shown first", async () => {
    vi.stubEnv("MAILCRAFT_ASSISTANT_MODEL", "c/three:free");
    await renderCard();
    expect(screen.getByText("Assistant (pinned by MAILCRAFT_ASSISTANT_MODEL)")).toBeTruthy();
    expect(screen.getAllByRole("listitem")[0].querySelector("code")?.textContent).toMatch("c/three:free");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an email model that does not end in :free is marked 'not free: refused' with the explanation", async () => {
    await renderCard("openai/gpt-5.5");
    const item = screen.getByText("openai/gpt-5.5", { selector: "code" }).closest("li")!;
    expect(item.textContent).toMatch("not free: refused");
    expect(screen.getAllByText("not free: refused")).toHaveLength(1); // only the email row, never the assistant chain
    expect(screen.getByText(/A model that is not free is never called\. Generated emails use their static copy/)).toBeTruthy();
    expect(item.textContent).not.toMatch("default, plus free fallbacks");
  });

  it("a :free email model is badged free with no warning", async () => {
    await renderCard("google/gemma-4-31b-it:free");
    const item = screen.getByText("google/gemma-4-31b-it:free", { selector: "code" }).closest("li")!;
    expect(within(item).getByText("free")).toBeTruthy();
    expect(screen.queryByText("not free: refused")).toBeNull();
    expect(screen.queryByText(/is never called/)).toBeNull();
  });

  it.each([undefined, null, ""])("an unset email model (%j) shows the default nvidia/nemotron-3.5-super-vl:free", async (unset) => {
    expect(EMAIL_DEFAULT_MODEL).toBe("nvidia/nemotron-3.5-super-vl:free");
    await renderCard(unset);
    const item = screen.getByText("nvidia/nemotron-3.5-super-vl:free", { selector: "code" }).closest("li")!;
    expect(within(item).getByText("free")).toBeTruthy();
    expect(item.textContent).toMatch("default, plus free fallbacks");
    expect(screen.queryByText("not free: refused")).toBeNull();
  });
});
