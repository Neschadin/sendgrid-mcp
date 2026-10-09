<p align="center">
  <img src="assets/sendgrid-logo.png" alt="SendGrid" width="320" />
</p>

# SendGrid MCP Server

MCP server for [Twilio SendGrid](https://sendgrid.com): transactional email with preflight checks, template management, delivery diagnostics, account/console settings, and optional local Event Webhook capture.

**End users run a single compiled binary — Bun is not required.**

Contact/list marketing CRUD is intentionally out of scope.

This project is community-maintained and is not affiliated with, endorsed by, or sponsored by Twilio SendGrid.

## Features

- **Safe send** — `sendgrid_validate_send_request`, `sendgrid_send_with_preflight`, sandbox mode
- **Templates** — list/create/update/activate dynamic templates
- **Diagnostics** — Email Activity, suppressions, stats, error classification, delivery triage
- **Webhooks** — Event Webhook config in SendGrid + optional local receiver (ngrok-friendly)
- **Account & console** — verified senders, domain auth, mail/tracking settings, alerts, inbound parse

Full tool catalog: [`MCP_TOOLS.md`](./MCP_TOOLS.md)

## Install (binary)

Download the binary for your OS from [GitHub Releases](https://github.com/Neschadin/sendgrid-mcp/releases).

| Platform            | Asset                      |
| ------------------- | -------------------------- |
| Linux x64           | `sendgrid-linux-x64`       |
| Linux arm64         | `sendgrid-linux-arm64`     |
| macOS Intel         | `sendgrid-darwin-x64`      |
| macOS Apple Silicon | `sendgrid-darwin-arm64`    |
| Windows x64         | `sendgrid-windows-x64.exe` |

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

| Variable              | Description                            |
| --------------------- | -------------------------------------- |
| `SENDGRID_API_KEY`    | SendGrid API key (`SG....`)            |
| `SENDGRID_FROM_EMAIL` | Default From address (verified sender) |

### Optional

| Variable                 | Default                       | Description                                                                                                      |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SENDGRID_FROM_NAME`     | `SendGrid MCP`                | Default From display name                                                                                        |
| `SENDGRID_REGION`        | `global`                      | Use `eu` for `https://api.eu.sendgrid.com/v3`. Also makes an empty Email Activity search fall back to Email Logs |
| `SENDGRID_API_BASE_URL`  | `https://api.sendgrid.com/v3` | Full SendGrid API base URL override                                                                              |
| `SENDGRID_ON_BEHALF_OF`  | —                             | `on-behalf-of` header value: a subuser username, or `account-id <id>` for a customer account                     |
| `READ_ONLY`              | `false`                       | When `true`, tools that send mail or change SendGrid return an error before any request                          |
| `SENDGRID_MCP_LOG_LEVEL` | `info`                        | `debug` \| `info` \| `warn` \| `error`                                                                           |

`SENDGRID_REGION` is case-insensitive (`eu` and `EU` both select the EU API). The MCP handshake `instructions` repeat the region, API base, from address, and the safe-send / delivery workflow. Tool arguments larger than 10000 combined array elements and object members are rejected. Responses replace `oauth_client_secret` and `api_key` values with a length marker.

### Optional: local Event Webhook receiver

Enabled only when `SENDGRID_EVENT_WEBHOOK_PORT` is set.

| Variable                                   | Default                            |
| ------------------------------------------ | ---------------------------------- |
| `SENDGRID_EVENT_WEBHOOK_PORT`              | _(disabled)_                       |
| `SENDGRID_EVENT_WEBHOOK_HOST`              | `0.0.0.0`                          |
| `SENDGRID_EVENT_WEBHOOK_PATH`              | `/sendgrid/events`                 |
| `SENDGRID_EVENT_WEBHOOK_HEALTH_PATH`       | `/sendgrid/events/health`          |
| `SENDGRID_EVENT_WEBHOOK_MAX_EVENTS`        | `5000`                             |
| `SENDGRID_EVENT_WEBHOOK_VERBOSE`           | `false`                            |
| `SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE` | `false`                            |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`        | — (required if signature enforced) |

Point SendGrid Event Webhook URL to your tunnel, e.g. `https://<ngrok-host>/sendgrid/events`. Inspect events via MCP tools `get_received_webhook_events` / `get_webhook_receiver_status`.

For public tunnels, prefer signed webhook verification:
`SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE=true` and
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=<SendGrid public key>`.

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

- **Send tools** can enqueue real email. Prefer `sendgrid_send_with_preflight` in automation. Set `READ_ONLY=true` to refuse every send and mutation before the API call.
- **Subusers:** `SENDGRID_ON_BEHALF_OF` is sent as the `on-behalf-of` header on every request (subuser username, or `account-id <id>`).
- **Mutating console tools** require `confirmToken: "CONFIRM"` (alerts, mail/tracking settings, verified senders, domains, webhooks).
- **Email Activity** (`/v3/messages`) may require the [Email Activity add-on](https://www.twilio.com/docs/sendgrid/api-reference/email-activity/filter-all-messages).

## v2 breaking changes

- MCP server name: `sendgrid-mcp-server`
- All tool names are prefixed: `sendgrid_<name>` (e.g. `sendgrid_validate_send_request`)
- List/read tools accept optional `response_format` (`markdown` | `json`) and return pagination metadata on list tools

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
bun run typecheck:tsc   # bun build graph + unit tests
bun run smoke
bun test tests
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
