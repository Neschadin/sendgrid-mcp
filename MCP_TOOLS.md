# SendGrid MCP Tools

Scope: transactional email hardening and SendGrid-side diagnostics.  
Out of scope: contact/list marketing CRUD.

## Core Runbooks

### Runbook: Safe Send

1. `validate_send_request`
2. `send_with_preflight` (or `send_email_advanced`)
3. On failure: `classify_sendgrid_error`
4. On delivery doubts: `triage_delivery_issue`

### Runbook: Delivery Incident

1. `search_message_activity` / `get_message_activity`
2. `check_suppression` and `list_suppressions`
3. `triage_delivery_issue`
4. If webhook exists: `get_received_webhook_events` + `analyze_engagement_anomalies`

### Runbook: Webhook Operations

1. `list_event_webhooks`
2. `update_event_webhook` / `toggle_event_webhook_signature`
3. `get_webhook_receiver_status`
4. Send test traffic and inspect `get_received_webhook_events`

---

## Tool Catalog

### `validate_send_request`
- **Purpose:** Preflight checks before send.
- **Inputs:** `request`, optional `partnerAccountId`, `checkSenderIdentity`.
- **Typical flow:** Run before every production send.
- **Caveats:** Does not send email; returns blockers/warnings/info.

### `send_with_preflight`
- **Purpose:** Validate then send only if no blockers.
- **Inputs:** `request`, optional `abortOnWarnings`, sender/account checks.
- **Typical flow:** Default send path for automation.
- **Caveats:** `abortOnWarnings=true` can block sends even without blockers.

### `send_email_advanced`
- **Purpose:** Full `/v3/mail/send` payload send.
- **Inputs:** `request` (all advanced fields).
- **Typical flow:** Use when payload already validated externally.
- **Caveats:** No automatic preflight.

### `send_template_email_advanced`
- **Purpose:** Advanced dynamic template send.
- **Inputs:** `to`, `templateId`, `dynamicTemplateData`, optional cc/bcc/asm/schedule.
- **Typical flow:** Template-based transactional mails.
- **Caveats:** Template/data mismatch can still fail if skipped preflight.

### `send_sandbox_email`
- **Purpose:** Send in SendGrid sandbox mode.
- **Inputs:** `request`.
- **Typical flow:** Validate payload integration without live delivery.
- **Caveats:** No recipient delivery occurs.

### `send_test_email`
- **Purpose:** Thin convenience wrapper for template test send.
- **Inputs:** `to`, `templateId`, `mockData`, optional from override.
- **Typical flow:** Quick manual smoke tests.
- **Caveats:** Limited surface vs advanced tools.

### `create_batch_id`
- **Purpose:** Create batch ID for scheduling controls.
- **Inputs:** none.
- **Typical flow:** Prior to scheduled campaigns.
- **Caveats:** Batch lifecycle controls require this ID.

### `schedule_email`
- **Purpose:** Schedule send (`send_at`) with optional batch auto-create.
- **Inputs:** `request`, `sendAt`, optional `batchId`, `autoCreateBatchId`.
- **Typical flow:** Deferred delivery and pacing.
- **Caveats:** `sendAt` must be in the future.

### `pause_scheduled_send`
- **Purpose:** Pause scheduled batch.
- **Inputs:** `batchId`.
- **Typical flow:** Temporary stop before campaign window.
- **Caveats:** Requires valid existing batch state.

### `resume_scheduled_send`
- **Purpose:** Resume by removing pause/cancel state.
- **Inputs:** `batchId`.
- **Typical flow:** Continue paused/canceled batch.
- **Caveats:** Behavior is API `DELETE` of scheduled-send state entry.

### `cancel_scheduled_send`
- **Purpose:** Cancel scheduled batch.
- **Inputs:** `batchId`.
- **Typical flow:** Emergency stop.
- **Caveats:** Near-send-time cancellation is not guaranteed by SendGrid.

### `classify_sendgrid_error`
- **Purpose:** Map SendGrid errors to probable causes and actions.
- **Inputs:** `statusCode`, `errorMessage`, `rawBody`.
- **Typical flow:** First response after API failure.
- **Caveats:** Heuristic classification; combine with activity/suppressions.

### `triage_delivery_issue`
- **Purpose:** Scenario-based delivery runbook with live checks.
- **Inputs:** `scenario` + optional recipient/from/template/message/activity params.
- **Typical flow:** `202 accepted`, `processing`, template/auth/DMARC/deferral incidents.
- **Caveats:** Depth depends on API access and provided identifiers.

### `search_message_activity`
- **Purpose:** Query Email Activity (`/v3/messages`) by SendGrid query syntax.
- **Inputs:** `query`, optional `limit`.
- **Typical flow:** Identify affected messages in an incident.
- **Caveats:** May require Email Activity add-on; query syntax must be valid.

### `get_message_activity`
- **Purpose:** Fetch one message activity by `msg_id`.
- **Inputs:** `msgId`.
- **Typical flow:** Deep dive on exact message status chain.
- **Caveats:** Same add-on access constraints as activity search.

### `list_suppressions`
- **Purpose:** Enumerate suppression entries by type.
- **Inputs:** `type`, optional pagination/time/email filters.
- **Typical flow:** Bulk suppression audits.
- **Caveats:** Does not mutate suppression lists.

### `check_suppression`
- **Purpose:** Check suppression flags for one recipient.
- **Inputs:** `email`.
- **Typical flow:** Per-recipient delivery triage.
- **Caveats:** Focused lookup only.

### `get_email_stats`
- **Purpose:** Aggregate daily delivery metrics.
- **Inputs:** `startDate`, optional `endDate`.
- **Typical flow:** Trend and blast-radius checks.
- **Caveats:** Aggregated metrics, not per-message forensics.

### `list_event_webhooks`
- **Purpose:** List Event Webhook configurations in SendGrid.
- **Inputs:** optional `includeAccountStatusChange`.
- **Typical flow:** Validate webhook fleet and event subscriptions.
- **Caveats:** Read-only inventory.

### `get_event_webhook`
- **Purpose:** Read one webhook configuration by ID.
- **Inputs:** `id`, optional include flag.
- **Typical flow:** Confirm exact event toggles and URL.
- **Caveats:** Requires valid webhook ID.

### `update_event_webhook`
- **Purpose:** Update webhook URL, enabled flag, and event toggles.
- **Inputs:** `id` + selected fields.
- **Typical flow:** Enable missing events / switch endpoint URL.
- **Caveats:** Signature mode is managed separately.

### `toggle_event_webhook_signature`
- **Purpose:** Enable/disable signed Event Webhook mode.
- **Inputs:** `id`, `enabled`.
- **Typical flow:** Enforce cryptographic source verification.
- **Caveats:** Public key changes can require receiver updates.

### `get_webhook_receiver_status`
- **Purpose:** Show local receiver runtime state and counters.
- **Inputs:** none.
- **Typical flow:** Verify receiver health after config or ngrok changes.
- **Caveats:** Local receiver must be enabled via env.

### `get_received_webhook_events`
- **Purpose:** Read buffered incoming Event Webhook payloads.
- **Inputs:** optional `limit`, `eventType`, `email`, `messageId`, `onlyVerified`.
- **Typical flow:** Incident reconstruction from near-real-time events.
- **Caveats:** In-memory buffer only; not persistent storage.

### `clear_received_webhook_events`
- **Purpose:** Clear local buffered webhook events.
- **Inputs:** `confirm=true`.
- **Typical flow:** Reset local buffer between test runs.
- **Caveats:** Irreversible in-memory clear.

---

## Optional Event Webhook Receiver (ngrok-ready)

Enable by setting env:

- `SENDGRID_EVENT_WEBHOOK_PORT` (required)
- `SENDGRID_EVENT_WEBHOOK_HOST` (default `0.0.0.0`)
- `SENDGRID_EVENT_WEBHOOK_PATH` (default `/sendgrid/events`)
- `SENDGRID_EVENT_WEBHOOK_HEALTH_PATH` (default `/sendgrid/events/health`)
- `SENDGRID_EVENT_WEBHOOK_MAX_EVENTS` (default `5000`)

Signature mode:

- `SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE` (`true`/`false`)
- `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` (required if signature required)
