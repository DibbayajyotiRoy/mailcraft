// The request body for one OpenRouter call: same shape the Rust client (mailcraft-llm) sends. Free models come with
// `models` fallbacks; require_parameters keeps routing to providers that honour tools; temperature stays low.
import type { ToolDef } from "./tools";

export const openai = (model: string, fallbacks: string[], messages: unknown[], tools: ToolDef[], maxTokens: number) => ({
  model, ...(fallbacks.length && { models: [model, ...fallbacks] }), messages, max_tokens: maxTokens, temperature: 0.2,
  ...(tools.length && { tools, tool_choice: "auto" }), provider: { require_parameters: true }, usage: { include: true },
});
