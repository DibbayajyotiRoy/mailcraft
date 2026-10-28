# mailcraft-llm

LLM providers (OpenRouter default, OpenAI, Ollama) and guarded slot generation for lifecycle emails:
generate, validate, one repair, static fallback.

## Environment

| Var | Values | Default |
|---|---|---|
| `MAILCRAFT_LLM_PROVIDER` | `openrouter`, `openai`, `ollama` | `openrouter` |
| `MAILCRAFT_LLM_MODEL` | OpenRouter: a `:free` model id (others are refused) | `nvidia/nemotron-3.5-super-vl:free` |
| `MAILCRAFT_LLM_FALLBACK_MODELS` | comma list of `:free` ids (OpenRouter only; paid entries are dropped with a warning) | `nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free` |
| `MAILCRAFT_LLM_REASONING` | `off`, `low`, `medium`, `high` (OpenRouter only) | `off` |
| `MAILCRAFT_LLM_GUARDRAILS` | `default`, `api-product` | `default` |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | key | required |

Reasoning is off by default: short email copy does not benefit and reasoning tokens eat `max_tokens`.
Pass `LlmSettings::guardrails` as `PersonalizeRequest.guardrails`. `api-product` is a stricter preset for developer-API products (no pricing promises, guarantees or internal engine names); it allows no link hosts, so add yours.

## Free models only

mailcraft uses strictly free OpenRouter models. An OpenRouter model id must end in `:free`: a paid
`MAILCRAFT_LLM_MODEL` (or a per-call override) is refused before any request is sent, logged as a
warning, and the email uses its static copy. Paid `MAILCRAFT_LLM_FALLBACK_MODELS` entries are dropped
with a warning. Only the `openrouter` provider is gated; `openai` and `ollama` ids are unchecked.

```
MAILCRAFT_LLM_MODEL=nvidia/nemotron-3.5-super-vl:free
MAILCRAFT_LLM_REASONING=off
```

Bake-off (2026-10-27, `mailer-research/bakeoff.md`): 3/4 first-try, 0 fallbacks, 1.6 s median. A free
OpenRouter key allows about 50 requests/day (20/min), so once it is spent emails go out as static copy
until the limit resets.
Not recommended: `dots-studio/dots-3-note-preview:free` (empty responses, 7 to 68 s) and
`xingchen-agi/xing4.0-29b-a4b:free` (upstream 429).

## Prompt controls

- `PersonalizeRequest.custom_instructions` (build with `merge_custom_instructions(workspace, step)`): untrusted style text,
  control chars stripped, capped at 2,000 chars (`Report.custom_instructions_truncated`), appended after the rules in a delimited
  section followed by a final rule. It cannot change the schema, links, footer or guardrails; the validator runs unchanged.
- Context `replies_enabled: false` (no-reply From address) swaps the "ask one question" line for "end plainly".
