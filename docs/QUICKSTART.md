# Quickstart

## With a domain (three commands)

```
docker compose up -d
mailcraft init                       # secret key, admin, test key, probes ports, prints next steps
mailcraft domain add example.com     # prints (or creates) SPF/DKIM/DMARC/return-path records, then verifies
```

- With `CLOUDFLARE_API_TOKEN` set, `domain add` creates the DNS records through the Cloudflare API and polls until `verified`.
- Without a token it prints a copy-paste block of records. Add them at your DNS host, then run `mailcraft domain verify example.com`. It exits 7 while records are missing and prints a hint.
- A domain cannot send until DKIM and the return path verify. A missing DMARC record is only a warning.
- Test send (works with the test key, delivers to the built-in sandbox inbox, nothing leaves the box):

```
mailcraft send --to delivered@test.mailcraft.local --subject "Hello" --text "It works" --json
```

Going live (a `mc_live_` key) is a human approval in the dashboard. Direct delivery from your own IP is opt-in and refused until `mailcraft doctor` passes; most users should use a relay (`mailcraft connect relay <preset>`).

## No domain: send through your own Gmail

For test or low-volume use only. Mail is sent from your own Gmail address through the Gmail API; Google signs it.

Honest limits: about 500 messages/day for free Gmail and about 2,000/day for Workspace, shared with the rest of that account's mail. From is your address, not an app address. Bulk or automated mail through a personal account may violate Google's terms. Keep it to personal or transactional scale.

mailcraft ships no shared Google OAuth client (`gmail.send` is a sensitive scope that needs Google verification for public apps), so each self-hoster creates their own. Verify against Google's current rules; the console labels below change.

1. In Google Cloud Console, create a project.
2. Enable the Gmail API for that project (APIs and Services, Library).
3. Configure the OAuth consent screen (Google Auth Platform). User type External (Internal for a Workspace-only setup). Fill in app name and your email.
4. Add the scope `https://www.googleapis.com/auth/gmail.send`.
5. Create credentials, OAuth client ID. Type Web application (add the redirect URI below) or Desktop app. Authorized redirect URI: `http://127.0.0.1:<port>/callback`, where `<port>` is the loopback port `mailcraft connect gmail` prints.
6. Set the publishing status to **In production**. Apps left in "Testing" issue refresh tokens that expire after 7 days. (Unverified production apps show a warning screen and are limited to 100 users; that is fine for your own account.)
7. Export the client credentials where the mailcraft server runs:

```
export MAILCRAFT_GOOGLE_CLIENT_ID=...
export MAILCRAFT_GOOGLE_CLIENT_SECRET=...
docker compose up -d        # restart so the server sees them
```

8. Connect:

```
mailcraft connect gmail
```

Open the printed URL, approve, and the CLI receives the callback on the loopback address. Then `mailcraft doctor`.
