# Inbound bounces, complaints and mailto unsubscribe

Outgoing mail uses a signed VERP envelope sender, `bounce+<email id>.<mac>@<return path host>`.
When a receiver sends a DSN (bounce) or an ARF feedback report back to that address, Mailcraft
records a `bounced` / `complained` event (so `email.bounced` / `email.complained` webhooks fire),
marks the email `bounced`, and applies the suppression policy: hard bounce suppresses, 3 soft
bounces in 7 days suppress, a complaint suppresses, a block-class bounce (5.7.x, reputation)
never suppresses the recipient. Reports without a MAC-verified token are ignored.

Pick one or more ways to get the reports in.

## 1. Built-in SMTP receiver

DNS (the return-path host is `bounces.<your sending domain>`, shown by `mailcraft domain show`):

```
bounces.mail.example.com.  MX  10 mx.example.com.
mx.example.com.            A   <this server's public IP>
```

Port 25 must reach the receiver: set `MAILCRAFT_INBOUND_SMTP_BIND=0.0.0.0:25` (needs
`CAP_NET_BIND_SERVICE`) or bind `:2525` and forward 25 to it. It accepts only verified `bounce+...`
and valid `unsub+...` recipients (anything else is `550`, nothing is relayed), has no STARTTLS,
and caps connections (64), recipients (20), idle time (60 s) and size.

| Env | Meaning |
|---|---|
| `MAILCRAFT_INBOUND_SMTP_BIND` | Listen address; unset = receiver off. |
| `MAILCRAFT_INBOUND_MAX_BYTES` | Max message size, default 5242880. |
| `MAILCRAFT_UNSUB_MAILTO` | e.g. `unsub@mx.example.com`: adds a `mailto:` to List-Unsubscribe (`unsub+<token>@mx.example.com`); needs the receiver and an MX for that host. The token must fit the 64-char local-part limit or the mailto is omitted. |
| `MAILCRAFT_UNSUB_SECRET` / `MAILCRAFT_SECRET_KEY` | Already required; the VERP MAC key is derived from the unsubscribe secret. Changing it invalidates bounces for mail still in flight. |

## 2. HTTP ingest

Set `MAILCRAFT_INGEST_TOKEN` (both routes answer 503 without it).

- `POST /ingest/raw`: body is one raw RFC 822 DSN or ARF message; `Authorization: Bearer <token>`.
  Use it from a mailbox poller, a Postfix `pipe`, or a provider's inbound webhook.
- `POST /ingest/ses`: Amazon SES via SNS. Set `MAILCRAFT_SES_TOPIC_ARNS` (comma separated) and
  subscribe the topic over HTTPS to `https://<host>/ingest/ses?token=<MAILCRAFT_INGEST_TOKEN>`;
  the subscription confirms itself. SES events are matched to emails by the SES message id.
  SNS message signatures are not verified; the secret URL token and the topic allowlist
  authenticate the call, so keep the URL private and use HTTPS.

## Limits

- A complaint's policy scope is "marketing only", but the `suppressions` table has no scope yet:
  it is stored and enforced as a full block.
- Block-class bounces are logged (`warn`) for the operator, not auto-paused.
- Some MTAs lowercase local parts, which breaks the case-sensitive VERP/unsubscribe tokens; those
  reports fail verification and are dropped.
