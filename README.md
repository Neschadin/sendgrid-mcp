# SendGrid MCP Server (Bun/TypeScript)

Transactional email hardening + **SendGrid-side diagnostics** (Email Activity API, suppressions, Event Webhooks).  
Contact/list marketing CRUD is intentionally excluded.

## Quickstart

### Install

```bash
bun install
```

### Run (stdio MCP)

```bash
SENDGRID_API_KEY="SG_..." \
SENDGRID_FROM_EMAIL="ops@yourdomain.com" \
SENDGRID_FROM_NAME="Ops" \
bun run start
```

### Cursor minimal config

Add this MCP server entry to Cursor (example shows the minimal env; `SENDGRID_EVENT_WEBHOOK_PORT` enables the optional HTTP receiver):

```json
"sendgrid-mcp": {
  "command": "/home/alex/.bun/bin/bun",
  "args": [
    "/home/alex/mcp_servers/sendgrid/src/index.ts"
  ],
  "env": {
    "SENDGRID_API_KEY": "SG.BX...",
    "SENDGRID_FROM_EMAIL": "kennitalan@kennitalan.is",
    "SENDGRID_FROM_NAME": "Kennitalan",
    "SENDGRID_EVENT_WEBHOOK_PORT": "8787"
  }
}
```

## Configuration (env)

### Required

- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`

### Optional

- `SENDGRID_FROM_NAME` (default: `Kennitalan`)

### Optional: receive Event Webhook (ngrok-friendly)

Receiver is enabled only if `SENDGRID_EVENT_WEBHOOK_PORT` is set.

- `SENDGRID_EVENT_WEBHOOK_PORT`
- `SENDGRID_EVENT_WEBHOOK_HOST` (default `0.0.0.0`)
- `SENDGRID_EVENT_WEBHOOK_PATH` (default `/sendgrid/events`)
- `SENDGRID_EVENT_WEBHOOK_HEALTH_PATH` (default `/sendgrid/events/health`)
- `SENDGRID_EVENT_WEBHOOK_MAX_EVENTS` (default `5000`)

Signature enforcement (optional):

- `SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE` (`true|false`)
- `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` (required if signature is enforced)

Note: the receiver does **not** log payloads to stdout. Inspect via MCP tools and/or the health endpoint.

## Caveats

- Email Activity API (`/v3/messages`) can require the Email Activity add-on. See `filter all messages` docs: `https://www.twilio.com/docs/sendgrid/api-reference/email-activity/filter-all-messages`.
- `send_email_advanced` sends without automatic preflight. Prefer `send_with_preflight` for production automation.

## Docs

- Tool runbooks and full catalog: `MCP_TOOLS.md`
- SendGrid developer docs: `https://www.twilio.com/docs/sendgrid/for-developers.md`
- SendGrid API reference: `https://www.twilio.com/docs/sendgrid/api-reference`
