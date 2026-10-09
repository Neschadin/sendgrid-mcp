<p align="center">
  <img src="assets/sendgrid-logo.png" alt="SendGrid" width="320" />
</p>

# SendGrid MCP Server

This server is for **transactional send and delivery**, not a map of the whole SendGrid API.

A thin SendGrid MCP treats `POST /v3/mail/send` as one call and spends the rest of its tools on contacts, lists, and campaigns. Those marketing APIs are out of scope here. The tools follow the checks SendGrid's own delivery troubleshooting expects:

1. **Before send.** `sendgrid_validate_send_request` checks the `/v3/mail/send` payload, that the dynamic template version is active, sender identity (domain authentication or a verified sender), link branding, recipient suppressions including the ASM group on the send, the DMARC warn list (`GET /v3/verified_senders/domains`), and that `send_at` is in the future and inside 72 hours. `sendgrid_send_with_preflight` posts only when that report has no blockers. Sandbox mode accepts the payload and does not deliver.
2. **After accept.** The `x-message-id` response header is not a `msg_id`. Pass it as `xMessageId`; search compiles `msg_id LIKE '<id>%'`, then `sendgrid_get_message_activity` reads the event chain (`reason`, `bounce_type`, `asm_group_id`, `outbound_ip`). Email Activity has no real offset. If Activity returns 403/404, or the region is `eu` and Activity is empty, use Email Logs (`POST /v3/logs`) with `to_email` equality. Logs rejects `msg_id`, `from_email`, and `LIKE`.
3. **When it did not arrive.** `sendgrid_check_suppression` and `sendgrid_triage_delivery_issue` cover bounce, block, spam, invalid, global unsubscribe, and ASM groups. `sendgrid_delete_suppression` lifts one entry. `sendgrid_classify_sendgrid_error` and `sendgrid_get_scopes` explain a 403. Paused or canceled scheduled batches are listed; a batch that was only given `send_at` is not in that list until you pause or cancel it.
4. **The pipe around the send.** Dynamic templates (including bulk rename and pruning inactive versions), Event Webhook create/update/test plus an optional local receiver, and the console settings that change delivery: domains, link branding, enforced TLS, mail and tracking settings, alerts, inbound parse.

Install: `bunx --no-env-file x @neschadin/sendgrid-mcp`.

Full catalog and runbooks: [`MCP_TOOLS.md`](./MCP_TOOLS.md).

This project is community-maintained and is not affiliated with, endorsed by, or sponsored by Twilio SendGrid.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4.2
- A [SendGrid API key](https://app.sendgrid.com/settings/api_keys) with scopes for the tools you call. Keys normally start with `SG.`; any other prefix only logs a warning
- A verified sender address in `SENDGRID_FROM_EMAIL`
- An MCP client (Cursor, Claude Desktop, VS Code, etc.)

One process, one API key. Do not share a hosted instance across tenants.

## Configuration

### Required

| Variable              | Description                            |
| --------------------- | -------------------------------------- |
| `SENDGRID_API_KEY`    | SendGrid API key                       |
| `SENDGRID_FROM_EMAIL` | Default From address (verified sender) |

### SendGrid

| Variable                 | Default        | Description                                                                                                      |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SENDGRID_FROM_NAME`     | `SendGrid MCP` | Default From display name                                                                                        |
| `SENDGRID_REGION`        | `global`       | `global` or `eu` (case-insensitive). `eu` uses `https://api.eu.sendgrid.com/v3` and falls back to Email Logs when Activity is empty |
| `SENDGRID_API_BASE_URL`  | from region    | Override the API host. `https://` or `http://`                                                                   |
| `SENDGRID_ON_BEHALF_OF`  | —              | Default `on-behalf-of` header: a subuser username, or `account-id <id>`                                          |
| `READ_ONLY`              | `false`        | `true` blocks send and mutating tools before any request                                                         |
| `SENDGRID_MCP_LOG_LEVEL` | `info`         | `debug`, `info`, `warn`, or `error`                                                                              |

Every tool also accepts `onBehalfOf`. The value `"parent"` skips `SENDGRID_ON_BEHALF_OF` for that call. List subusers with `sendgrid_list_subusers` (the parent key needs that scope; this key may 403).

Handshake `instructions` repeat the region, API base, from address, and the workflow above. A tool call with more than 10000 combined array elements and object members is rejected. Results replace `oauth_client_secret` and `api_key` values with a length marker.

### Remote HTTP

Leave `MCP_TRANSPORT` unset for stdio. Set `MCP_TRANSPORT=http` to serve Streamable HTTP on `/mcp` (`/health` is unauthenticated).

| Variable              | Default        | Description                                                                 |
| --------------------- | -------------- | --------------------------------------------------------------------------- |
| `MCP_HTTP_HOST`       | `127.0.0.1`    | Bind address                                                                |
| `MCP_HTTP_PORT`       | `3000`         | Port                                                                        |
| `MCP_AUTH_MODE`       | `token`        | `token` or `none`. `none` is refused when the bind address is not loopback |
| `MCP_AUTH_TOKEN`      | —              | Bearer token. Required for `token` mode                                    |
| `MCP_ALLOWED_HOSTS`   | loopback names | Comma-separated `Host` allowlist. Required off loopback                     |
| `MCP_ALLOWED_ORIGINS` | loopback names | Comma-separated `Origin` allowlist. A missing `Origin` is allowed           |
| `MCP_TLS_KEY_FILE`    | —              | TLS key. Set together with `MCP_TLS_CERT_FILE`                              |
| `MCP_TLS_CERT_FILE`   | —              | TLS certificate                                                             |
| `MCP_TRUST_PROXY`     | `false`        | Allow plaintext HTTP off loopback only behind your own TLS proxy            |

### Local Event Webhook receiver

Off until `SENDGRID_EVENT_WEBHOOK_PORT` is set. The buffer is in-memory (default 5000 events) and is dropped when the process exits.

| Variable                                   | Default                   |
| ------------------------------------------ | ------------------------- |
| `SENDGRID_EVENT_WEBHOOK_HOST`              | `0.0.0.0`                 |
| `SENDGRID_EVENT_WEBHOOK_PATH`              | `/sendgrid/events`        |
| `SENDGRID_EVENT_WEBHOOK_HEALTH_PATH`       | `/sendgrid/events/health` |
| `SENDGRID_EVENT_WEBHOOK_MAX_EVENTS`        | `5000`                    |
| `SENDGRID_EVENT_WEBHOOK_VERBOSE`           | `false`                   |
| `SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE` | `false`                   |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`        | required when signature is required |

Point the SendGrid Event Webhook URL at the tunnel, for example `https://<ngrok-host>/sendgrid/events`. Read what arrived with `sendgrid_get_received_webhook_events` and `sendgrid_get_webhook_receiver_status`. Create or test the SendGrid-side webhook with `sendgrid_manage_event_webhook`.

## MCP client setup

### Cursor

[`mcp.json.example`](./mcp.json.example). `--no-env-file` stops Bun from also reading a `.env` in the client cwd. In `~/.cursor/mcp.json`, `envFile` must be an absolute path.

```json
{
  "mcpServers": {
    "sendgrid": {
      "command": "bunx",
      "args": ["--no-env-file", "x", "@neschadin/sendgrid-mcp"],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

Remote HTTP, after the server process is started with `MCP_TRANSPORT=http`:

```json
{
  "mcpServers": {
    "sendgrid": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

### Claude Desktop

No `envFile`. The desktop cwd is not your repo, so pass an absolute `--env-file`:

```json
{
  "mcpServers": {
    "sendgrid": {
      "command": "bunx",
      "args": [
        "--no-env-file",
        "--env-file=/absolute/path/.env",
        "x",
        "@neschadin/sendgrid-mcp"
      ]
    }
  }
}
```

Restart the client after changing MCP config.

## Safety

- Send tools can enqueue real mail. They do not ask for `confirmToken`. Use `sendgrid_send_with_preflight`, or set `READ_ONLY=true`.
- Tools that change SendGrid (templates, suppressions, webhooks, domains, settings, scheduled-send pause/cancel) require `confirmToken` `"CONFIRM"`.
- `READ_ONLY=true` blocks both sends and those mutations before the HTTP call.
- Email Activity (`/v3/messages`) may require the [Email Activity add-on](https://www.twilio.com/docs/sendgrid/api-reference/email-activity/filter-all-messages).

## Development

A git tag `vX.Y.Z` runs tests, publishes `@neschadin/sendgrid-mcp` to npm, then publishes `io.github.Neschadin/sendgrid-mcp` to the MCP registry. The release has no binary assets.

```bash
git clone https://github.com/Neschadin/sendgrid-mcp.git
cd sendgrid-mcp
bun install
bun run dev          # stdio MCP; loads .env
bun run lint
bun run typecheck
bun run smoke
bun test
```

```bash
bun run inspect
```

## Docs

- [MCP_TOOLS.md](./MCP_TOOLS.md) — tools, runbooks, risk matrix
- [SendGrid API reference](https://www.twilio.com/docs/sendgrid/api-reference)
- [SendGrid for developers](https://www.twilio.com/docs/sendgrid/for-developers)

## License

MIT — see [LICENSE](./LICENSE).
