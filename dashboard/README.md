# mailcraft dashboard

Next.js 16 app; all API calls happen server-side. Sign in at `/login` with an API base URL and a key (stored in an httpOnly, SameSite=Strict cookie).

```
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
npm test
```

| Env | Default | Purpose |
|---|---|---|
| `MAILCRAFT_API_URL` | `http://localhost:8080` | Pre-filled API base URL on the login form |

Endpoints marked "assumed" in `docs/ASSUMED-ENDPOINTS.md` (kill-switch GET, account status, stats overview, settings) must exist server-side; pages show the API error otherwise.

## Assistant

A side panel (header button, Cmd/Ctrl+K) that drafts automations, broadcasts, template fixes and contact changes, and explains bounces. It runs server-side on free, open-weight OpenRouter models only, acts as the signed-in user's own key, and only **proposes**: nothing changes until you press Apply (sends on a live key ask again). Off until `OPENROUTER_API_KEY` is set.

| Env | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | unset (assistant off) | OpenRouter key; a free key is enough |
| `MAILCRAFT_ASSISTANT_MODEL` | automatic | Pin the first model; refused unless it is free and supports tools |
| `MAILCRAFT_ASSISTANT_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL; the offline mock uses it |

For local work with no key: `node scripts/mock-api.mjs 18080`, then run the dashboard with `MAILCRAFT_ASSISTANT_BASE_URL=http://127.0.0.1:18080/openrouter/api/v1`. Free-model rule, tools, proposal flow, limits and troubleshooting: [docs/ASSISTANT.md](../docs/ASSISTANT.md).

### Write with AI (New email dialog)

**Write with AI** in the New email dialog drafts the subject and body (or, on the template tab, the template's variables) from one sentence, and the fields fill in live while the model writes. It uses the same key, free-model rule and fallback chain as the assistant (`POST /api/compose/write`, NDJSON), sends the model only contact names, never addresses, and treats template text as untrusted data. It never sends: Send stays yours, and **Stop**, **Regenerate** and **Undo AI** are always there.

