---
name: mailcraft-write-templates
description: Write mailcraft email templates in the JSON block format, preview and lint them, and import or export HTML, MJML or JSON. Use when the user wants an email template created, converted or debugged.
---

# Write templates

## Rules
1. `--json` always; never print keys.
2. Prefer the JSON block tree. Use `raw_html` / `raw_mjml` blocks only when importing existing markup.
3. Variables use `{{ name }}` with strict undefined: a missing variable is an error (`template_render_failed`), never "Hi null". Give optional ones a default: `{{ first_name | default('there') }}`.
4. Do not write the unsubscribe link or postal address into marketing templates; the footer is template-owned.

## Format
```json
{"version": 1, "subject": "Welcome {{ first_name | default('there') }}",
 "blocks": [
  {"type": "heading", "text": "Hi {{ first_name }}"},
  {"type": "paragraph", "text": "Thanks for joining."},
  {"type": "button", "label": "Open app", "url": "{{ app_url }}"},
  {"type": "divider"},
  {"type": "raw_mjml", "mjml": "<mj-text>...</mj-text>"}]}
```
Reserved variables: `first_name`, `last_name`, `email`, `unsubscribe_url`, `preferences_url`, `workspace.name`. LLM text goes in a `slot` block: `{"type": "slot", "name": "intro", "max_len": 240, "instructions": "...", "fallback": "static copy"}`. Planned (not in the scaffold): `image`, `if`/`for`, `footer`. A template must be published (`mailcraft templates publish <alias>`) before sends and automations use it.

## Steps
```
mailcraft templates import welcome.json --name welcome --json
mailcraft templates preview <id> --data '{"first_name":"Ana","app_url":"https://app.example.com"}' --json
mailcraft templates export <id> --format mjml --json
mailcraft templates list --json
```
`preview` returns `subject`, `html`, `text`, `lint[]`; fix every lint issue. `preview <id> --file draft.html` renders unsaved content (nothing is stored); `--version N` renders an older saved version. `templates versions <id>` lists the history, `templates restore <id> <version>` copies an old version into a new draft (then `publish`), `templates discard-draft <id>` drops unpublished versions for good. Import formats: `html` becomes a `raw_html` block, `mjml` a `raw_mjml` block, `json` is canonical. React Email: render to HTML in CI, then import the HTML. Resend `{{{VAR}}}` becomes `{{ VAR }}`. JSON and MJML of block-built templates round-trip; raw blocks pass through.

## Pitfalls
- Keep HTML under about 100 KB (Gmail clips larger messages; unverified vendor claim).
- A plain-text part is generated; check it in the preview.
- Links must be https and not shorteners or IP hosts.
- The LLM validator rejects drafts containing `{{ }}`, `[...]`, `undefined` or `null`.
