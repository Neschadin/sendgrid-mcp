<p align="center">
  <img src="assets/sendgrid-logo.png" alt="SendGrid" width="320" />
</p>

# SendGrid MCP Server

MCP server for [Twilio SendGrid](https://sendgrid.com): transactional email with preflight checks, template management, delivery diagnostics, account/console settings, and optional local Event Webhook capture.

**End users run a single compiled binary — Bun is not required.**

Contact/list marketing CRUD is intentionally out of scope.

## Features

- **Safe send** — `validate_send_request`, `send_with_preflight`, sandbox mode
- **Templates** — list/create/update/activate dynamic templates
- **Diagnostics** — Email Activity, suppressions, stats, error classification, delivery triage
- **Webhooks** — Event Webhook config in SendGrid + optional local receiver (ngrok-friendly)
- **Account & console** — verified senders, domain auth, mail/tracking settings, alerts, inbound parse

Full tool catalog: [`MCP_TOOLS.md`](./MCP_TOOLS.md)

## Install (binary)

Download the binary for your OS from [GitHub Releases](https://github.com/Neschadin/sendgrid-mcp/releases).

| Platform | Asset |
|----------|--------|
| Linux x64 | `sendgrid-linux-x64` |
| Linux arm64 | `sendgrid-linux-arm64` |
| macOS Intel | `sendgrid-darwin-x64` |
| macOS Apple Silicon | `sendgrid-darwin-arm64` |

```bash
chmod +x sendgrid-linux-x64
mv sendgrid-linux-x64 ~/.local/bin/sendgrid
```

The binary is built with `bun build --compile` and **embeds the Bun runtime**. Users do not install Bun.

## Requirements

- A [SendGrid API key](https://app.sendgrid.com/settings/api_keys) with scopes for the tools you use
- A **verified sender** address matching `SENDGRID_FROM_EMAIL`
- An MCP client (Cursor, Claude Desktop, VS Code, etc.)

Each user runs the server locally with **their own** API key (bring-your-own-key). Do not share one hosted instance with shared credentials.

## Configuration

### Required environment variables

| Variable | Description |
|----------|-------------|
| `SENDGRID_API_KEY` | SendGrid API key (`SG....`) |
| `SENDGRID_FROM_EMAIL` | Default From address (verified sender) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SENDGRID_FROM_NAME` | `SendGrid MCP` | Default From display name |
| `SENDGRID_MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Optional: local Event Webhook receiver

Enabled only when `SENDGRID_EVENT_WEBHOOK_PORT` is set.

| Variable | Default |
|----------|---------|
| `SENDGRID_EVENT_WEBHOOK_PORT` | *(disabled)* |
| `SENDGRID_EVENT_WEBHOOK_HOST` | `0.0.0.0` |
| `SENDGRID_EVENT_WEBHOOK_PATH` | `/sendgrid/events` |
| `SENDGRID_EVENT_WEBHOOK_HEALTH_PATH` | `/sendgrid/events/health` |
| `SENDGRID_EVENT_WEBHOOK_MAX_EVENTS` | `5000` |
| `SENDGRID_EVENT_WEBHOOK_VERBOSE` | `false` |
| `SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE` | `false` |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | — (required if signature enforced) |

Point SendGrid Event Webhook URL to your tunnel, e.g. `https://<ngrok-host>/sendgrid/events`. Inspect events via MCP tools `get_received_webhook_events` / `get_webhook_receiver_status`.

## MCP client setup

### Cursor

Settings → MCP → add server (or edit `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sendgrid": {
      "command": "/absolute/path/to/sendgrid",
      "args": [],
      "env": {
        "SENDGRID_API_KEY": "SG.xxx",
        "SENDGRID_FROM_EMAIL": "you@yourdomain.com",
        "SENDGRID_FROM_NAME": "Your App"
      }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "sendgrid": {
      "command": "/absolute/path/to/sendgrid",
      "args": [],
      "env": {
        "SENDGRID_API_KEY": "SG.xxx",
        "SENDGRID_FROM_EMAIL": "you@yourdomain.com"
      }
    }
  }
}
```

Restart the client after changing MCP config.

## Safety

- **Send tools** can enqueue real email. Prefer `send_with_preflight` in automation.
- **Mutating console tools** require `confirmToken: "CONFIRM"` (alerts, mail/tracking settings, verified senders, domains, webhooks).
- **Email Activity** (`/v3/messages`) may require the [Email Activity add-on](https://www.twilio.com/docs/sendgrid/api-reference/email-activity/filter-all-messages).

## Development (maintainers only)

Bun is only needed to **build from source**, not to run the release binary.

```bash
git clone https://github.com/Neschadin/sendgrid-mcp.git
cd sendgrid-mcp
bun install
bun run dev          # stdio MCP from TypeScript
bun run build        # compile → bin/sendgrid (local platform)
./scripts/build-release.sh   # all release targets → dist/
bun run lint
bun run typecheck
```

### MCP Inspector

```bash
SENDGRID_API_KEY=SG.xxx SENDGRID_FROM_EMAIL=you@domain.com bun run inspect
```

## Docs

- [MCP_TOOLS.md](./MCP_TOOLS.md) — tools, runbooks, risk matrix
- [SendGrid API reference](https://www.twilio.com/docs/sendgrid/api-reference)
- [SendGrid for developers](https://www.twilio.com/docs/sendgrid/for-developers)

## License

MIT — see [LICENSE](./LICENSE).
