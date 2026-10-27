---
name: mailcraft-custom-instructions
description: Write good workspace and per-step custom instructions that shape the tone of LLM-written emails. Use when the user wants AI emails to sound a certain way.
---

# Custom instructions

Workspace level (Dashboard: Settings > AI writing, or `mailcraft settings instructions set "<text>" | set --file f | get | clear`, MCP `settings_set_instructions`, SDK `settings.instructions.set`): max 2,000 characters, admin key to change. Per step: `config.custom_instructions` on a `send_email` step with `mode: llm`, max 1,000 characters; it is appended after the workspace text.

## Rules
1. Style and tone only: voice, length, formality, sign-off, words to prefer or avoid. Not facts about the product.
2. They rank below mailcraft's rules and cannot override them: no invented features, links come only from templates, unsubscribe is always included. Do not ask for these; they are enforced anyway.
3. Be specific and short: "Under 120 words, first person, no exclamation marks" beats "be nice".
4. Say what to do, not what to avoid, except for a short "never use" list.
5. One voice per workspace; put step-specific goals ("this is the day-3 nudge: one question, no pitch") in the step override.
6. Check the result with `automations simulate` or a test-key send; never put secrets or personal data in instructions.

## Examples
- Friendly founder: "Write like a friendly founder emailing one person: first person, warm, plain words, short paragraphs."
- Concise and technical: "Be concise and technical. Short sentences, no filler. Name the exact feature or step."
- Warm and supportive: "Acknowledge the reader's situation first, encourage without pressure, offer help in one sentence."
