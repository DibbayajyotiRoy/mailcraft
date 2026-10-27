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
