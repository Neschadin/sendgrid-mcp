# SendGrid MCP Tools

Scope: transactional email hardening and SendGrid-side diagnostics.  
Out of scope: contact/list marketing CRUD.

**Handshake metadata (v2):** Server name is `sendgrid-mcp-server`. The handshake `instructions` carry the safe-send and delivery workflow for this process (region, API base, from address). All tools are exposed as `sendgrid_<name>`. Mutating tools with required `confirmToken` automatically append `Requires confirmToken="CONFIRM".` to the tool `description`. Read tools expose `outputSchema`, `structuredContent`, optional `response_format` (`markdown`|`json`), and list pagination metadata (`total_count`, `count`, `offset`, `has_more`, `next_offset`). A tool call whose arguments contain more than 10000 combined array elements and object members is rejected before the handler runs. Tool results redact `oauth_client_secret` and `api_key`.

## Core Runbooks

### Runbook: Safe Send

1. `sendgrid_validate_send_request`
2. `sendgrid_send_with_preflight` (or `sendgrid_send_email_advanced`)
3. On failure: `sendgrid_classify_sendgrid_error`
4. On delivery doubts: `sendgrid_triage_delivery_issue`

### Runbook: Delivery Incident

1. `sendgrid_search_message_activity` / `sendgrid_get_message_activity` (or `sendgrid_search_email_logs` when Activity is empty or 403, especially on EU)
2. `sendgrid_check_suppression` and `sendgrid_list_suppressions`; lift a hit with `sendgrid_delete_suppression`
3. `sendgrid_triage_delivery_issue`
4. If webhook exists: `sendgrid_get_received_webhook_events` + `sendgrid_analyze_engagement_anomalies`

### Runbook: Webhook Operations

1. `sendgrid_list_event_webhooks`
2. `sendgrid_update_event_webhook` / `sendgrid_toggle_event_webhook_signature`
3. `sendgrid_get_webhook_receiver_status`
4. Send test traffic and inspect `sendgrid_get_received_webhook_events`

---

## Tool Catalog

### `sendgrid_list_templates`
- **Purpose:** List all dynamic templates from SendGrid (full pagination).
- **Inputs:** none.
- **Typical flow:** Inventory before edits/migrations.
- **Caveats:** Returns dynamic templates only.

### `sendgrid_rename_template`
- **Purpose:** Rename one template by template ID.
- **Inputs:** `confirmToken="CONFIRM"`, `templateId`, `newName`.
- **Typical flow:** Safe targeted rename.
- **Caveats:** Changes template display name only.

### `sendgrid_rename_templates_bulk`
- **Purpose:** Bulk rename by `templateId` and/or `oldName`.
- **Inputs:** `renames[]`, optional `dryRun`, `confirmToken`, `stopOnError`, `requireUniqueOldName`.
- **Typical flow:** Large naming migrations.
- **Caveats:** Use `dryRun=true` first on production accounts.

### `sendgrid_get_template_html`
- **Purpose:** Read HTML of active or explicit template version.
- **Inputs:** `templateId`, optional `versionId`.
- **Output:** `structuredContent` with `templateId`, `versionId`, `active`, `name`, `subject`, `updatedAt`, `htmlContent`.
- **Typical flow:** Inspect/render debugging.
- **Caveats:** If `versionId` omitted, active version is used.

### `sendgrid_create_template`
- **Purpose:** Create a dynamic template with first active version.
- **Inputs:** `confirmToken="CONFIRM"`, `name`, `versionName`, `subject`, `htmlContent`.
- **Typical flow:** Bootstrap new notification templates.
- **Caveats:** Creates both template and version in one operation.

### `sendgrid_update_template_html`
- **Purpose:** Update version-level content/subject/name.
- **Inputs:** `confirmToken="CONFIRM"`, `templateId`, `versionId`, optional `htmlContent`, `subject`, `name`.
- **Typical flow:** Iterative edits to an existing version.
- **Caveats:** Does not auto-activate version.

### `sendgrid_activate_template_version`
- **Purpose:** Activate a template version.
- **Inputs:** `confirmToken="CONFIRM"`, `templateId`, `versionId`.
- **Typical flow:** Release updated template content.
- **Caveats:** Only one version can be active.

### `sendgrid_prune_inactive_template_versions`
- **Purpose:** Delete inactive versions for one or more templates, keeping active versions.
- **Inputs:** `templateIds[]`, optional `dryRun` (default `true`), optional `confirmToken` required when `dryRun=false`.
- **Typical flow:** Cleanup after template version migrations.
- **Caveats:** Destructive when `dryRun=false`; use dry-run first.

### `sendgrid_delete_template`
- **Purpose:** Permanently delete a template.
- **Inputs:** `confirmToken="CONFIRM"`, `templateId`.
- **Typical flow:** Cleanup unused templates.
- **Caveats:** Irreversible.

### `sendgrid_sync_template_ids`
- **Purpose:** Compare local `SENDGRID_TEMPLATES` constants with live SendGrid templates.
- **Inputs:** `constantsPath`.
- **Typical flow:** Keep backend constants aligned with real template IDs.
- **Caveats:** Local constants parsing is regex-based.

### `sendgrid_validate_send_request`
- **Purpose:** Preflight checks before send. Run this before any `send_*` call. Validates `/v3/mail/send` payload shape, active dynamic template, sender identity (domain authentication or verified sender), link branding alignment, recipient suppressions (including ASM group unsubscribe when `asm.groupId` is set), DMARC warn-list domains from `GET /v3/verified_senders/domains`, and scheduling limits (`send_at` future + within 72 hours).
- **Inputs:** `request`, optional `partnerAccountId`, `checkSenderIdentity`.
- **Output:** `structuredContent` with `ok`, `blockers`, `warnings`, `info`.
- **Typical flow:** Dry-run review before every production send.
- **Caveats:** Does not send email.

### `sendgrid_send_with_preflight`
- **Purpose:** Preferred production send path: runs `sendgrid_validate_send_request` checks first, then `POST /v3/mail/send` only when no blockers (and optionally no warnings with `abortOnWarnings`).
- **Inputs:** `request`, optional `abortOnWarnings`, sender/account checks.
- **Output:** `structuredContent` with `sent`, `report`, `statusCode`, `messageId`.
- **Typical flow:** Default send path for automation. Use `sendgrid_validate_send_request` alone when you only need a dry-run.
- **Caveats:** `abortOnWarnings=true` can block sends even without blockers.

### `sendgrid_send_email_advanced`
- **Purpose:** Full `/v3/mail/send` payload send.
- **Inputs:** `request` (all advanced fields).
- **Typical flow:** Use when payload already validated externally.
- **Caveats:** No automatic preflight.

### `sendgrid_send_template_email_advanced`
- **Purpose:** Advanced dynamic template send.
- **Inputs:** `to`, `templateId`, `dynamicTemplateData`, optional cc/bcc/asm/schedule.
- **Typical flow:** Template-based transactional mails.
- **Caveats:** Template/data mismatch can still fail if skipped preflight.

### `sendgrid_send_sandbox_email`
- **Purpose:** Send in SendGrid sandbox mode.
- **Inputs:** `request`.
- **Typical flow:** Validate payload integration without live delivery.
- **Caveats:** No recipient delivery occurs.

### `sendgrid_send_test_email`
- **Purpose:** Thin convenience wrapper for template test send; sandbox mode is used by default.
- **Inputs:** `to`, `templateId`, `mockData`, optional from override, optional `liveDelivery` + `confirmToken="CONFIRM"`.
- **Typical flow:** Quick manual smoke tests.
- **Caveats:** No live delivery occurs unless `liveDelivery=true` and `confirmToken` is provided.

### `sendgrid_create_batch_id`
- **Purpose:** Create batch ID for scheduling controls.
- **Inputs:** none.
- **Typical flow:** Prior to scheduled campaigns.
- **Caveats:** Batch lifecycle controls require this ID.

### `sendgrid_schedule_email`
- **Purpose:** Schedule send (`send_at`) with optional batch auto-create.
- **Inputs:** `request`, `sendAt`, optional `batchId`, `autoCreateBatchId`.
- **Typical flow:** Deferred delivery and pacing.
- **Caveats:** `sendAt` must be in the future and within SendGrid's 72-hour scheduling window.

### `sendgrid_list_scheduled_sends`
- **Purpose:** List batches that are paused or canceled (`GET /v3/user/scheduled_sends`).
- **Inputs:** none.
- **Caveats:** A `send_at` batch that was never paused or canceled is absent.

### `sendgrid_get_scheduled_send`
- **Purpose:** Read pause/cancel state for one `batch_id`.
- **Inputs:** `batchId`.
- **Caveats:** A missing batch comes back from SendGrid as `200` and `[]`, not 404. This tool reports that as not found.

### `sendgrid_pause_scheduled_send`
- **Purpose:** Pause scheduled batch.
- **Inputs:** `confirmToken="CONFIRM"`, `batchId`.
- **Typical flow:** Temporary stop before campaign window.
- **Caveats:** Requires valid existing batch state.

### `sendgrid_resume_scheduled_send`
- **Purpose:** Resume by removing pause/cancel state.
- **Inputs:** `confirmToken="CONFIRM"`, `batchId`.
- **Typical flow:** Continue paused/canceled batch.
- **Caveats:** Behavior is API `DELETE` of scheduled-send state entry.

### `sendgrid_cancel_scheduled_send`
- **Purpose:** Cancel scheduled batch.
- **Inputs:** `confirmToken="CONFIRM"`, `batchId`.
- **Typical flow:** Emergency stop.
- **Caveats:** Near-send-time cancellation is not guaranteed by SendGrid.

### `sendgrid_classify_sendgrid_error`
- **Purpose:** Map SendGrid errors to probable causes and actions.
- **Inputs:** `statusCode`, `errorMessage`, `rawBody`.
- **Typical flow:** First response after API failure.
- **Caveats:** Heuristic classification; combine with activity/suppressions.

### `sendgrid_triage_delivery_issue`
- **Purpose:** Scenario-based delivery runbook with live checks.
- **Inputs:** `scenario` + optional recipient/from/template/message/activity params.
- **Typical flow:** `202 accepted`, `processing`, template/auth/DMARC/deferral incidents.
- **Caveats:** Depth depends on API access and provided identifiers.

### `sendgrid_search_message_activity`
- **Purpose:** Query Email Activity (`GET /v3/messages`) by SendGrid query syntax.
- **Inputs:** `query` and/or `xMessageId`, optional `limit`. `offset` above 0 is rejected: this API has no offset.
- **Typical flow:** Identify affected messages in an incident. Pass the Mail Send `x-message-id` response header as `xMessageId`; it is compiled to `msg_id LIKE '<id>%'`.
- **Caveats:** May require the Email Activity add-on. `limit` is 1–1000. There is no cursor. On 403/404, and on an empty result when `SENDGRID_REGION=eu`, the tool falls back to `POST /v3/logs`.

### `sendgrid_search_email_logs`
- **Purpose:** Search Email Logs (`POST /v3/logs`) when Activity is missing, especially for EU regional subusers.
- **Inputs:** optional `query`, `limit` (1–1000), `subusers` (parent account, exactly one username).
- **Typical flow:** `to_email='user@example.com'`, `status IN ('bounced','deferred')`, or `sg_message_id='<full id>'`.
- **Caveats:** Allowed fields are `sg_message_id`, `subject`, `to_email`, `status`, `reason`, `categories`, `sg_message_id_created_at`. Operators are `=` / `IN` / time comparisons. Combine with `AND`. No nesting. No event chain.

### `sendgrid_get_message_activity`
- **Purpose:** Fetch one message by `msg_id`, including the event chain (`reason`, `bounce_type`, `mx_server`, `asm_group_id`, `outbound_ip`).
- **Inputs:** `msgId` — full `msg_id` or the Mail Send `x-message-id`.
- **Typical flow:** Deep dive after search. An `x-message-id` is resolved with `msg_id LIKE` and then re-fetched.
- **Caveats:** Activity may require the add-on. A full id that 403/404s is loaded from Email Logs, which has status and reason but no events. EU regional subusers often have no Activity detail.

### `sendgrid_list_asm_groups`
- **Purpose:** List ASM unsubscribe groups (`GET /v3/asm/groups`) so `asm.groupId` does not have to be guessed.
- **Inputs:** none.
- **Caveats:** Not a marketing contact list.

### `sendgrid_create_asm_group`
- **Purpose:** Create an ASM unsubscribe group.
- **Inputs:** `confirmToken="CONFIRM"`, `name`, `description`, optional `isDefault`.
- **Caveats:** Does not add recipients.

### `sendgrid_list_categories`
- **Purpose:** List category names (`GET /v3/categories`) for `sendgrid_get_email_stats` `dimension=category`.
- **Inputs:** optional `category`, `limit`, `offset`.
- **Caveats:** Names only, not metrics.

### `sendgrid_list_suppressions`
- **Purpose:** Enumerate suppression entries by type.
- **Inputs:** `type`, optional pagination/time/email filters.
- **Typical flow:** Bulk suppression audits.
- **Caveats:** Does not mutate suppression lists. `global_unsubscribes` is an alias for SendGrid global unsubscribe listing.

### `sendgrid_check_suppression`
- **Purpose:** Check bounce, block, global unsubscribe, spam report, invalid-email, and ASM group suppression flags for one recipient (`GET /v3/asm/suppressions/{email}`).
- **Inputs:** `email`.
- **Typical flow:** Per-recipient delivery triage. Group rows include `id`, `name`, and `suppressed`.
- **Caveats:** The ASM call returns every group, not only suppressed ones. A failed group lookup is reported in `groupLookupError` and does not clear the other flags.

### `sendgrid_delete_suppression`
- **Purpose:** Remove one recipient from bounce, block, spam report, invalid email, global unsubscribe, or a single ASM group.
- **Inputs:** `confirmToken="CONFIRM"`, `email`, `type` (`bounce` | `block` | `spam_report` | `invalid_email` | `global` | `group`), `groupId` when `type=group`.
- **Typical flow:** After `check_suppression` shows the list that is dropping mail.
- **Caveats:** Does not delete the ASM group. `READ_ONLY=true` blocks the call before the API request.

### `sendgrid_get_email_stats`
- **Purpose:** Aggregate delivery metrics. `dimension=global` is the daily account rollup.
- **Inputs:** `startDate`, optional `endDate`, `dimension` (`global` | `category` | `category_sums` | `mailbox_provider` | `geo` | `browser` | `device` | `client`), `aggregatedBy` (`day` | `week` | `month`). `category` requires `categories`. Optional `mailboxProviders`, `country`, `browsers`, `limit`.
- **Typical flow:** Trend and blast-radius checks. Use `category` for categories sent on the mail payload, `mailbox_provider` for provider-specific drops.
- **Caveats:** Aggregated metrics, not per-message forensics. Browser, device, and client stats retain about 7 days.

### `sendgrid_list_subusers`
- **Purpose:** List subusers on the parent account (`GET /v3/subusers`), including region when `includeRegion` is true (the default).
- **Inputs:** optional `username`, `region` (`all` | `global` | `eu`), `limit`, `offset`, `includeRegion`.
- **Typical flow:** Pick `username`, then pass it as `onBehalfOf` on later tools. `onBehalfOf` is optional on every tool. `onBehalfOf="parent"` ignores `SENDGRID_ON_BEHALF_OF` for that call.
- **Caveats:** The parent API key must be allowed to list subusers. A key already scoped with `SENDGRID_ON_BEHALF_OF` is not the parent; pass `onBehalfOf="parent"` for this list.

### `sendgrid_get_scopes`
- **Purpose:** List scopes on the current API key (`GET /v3/scopes`).
- **Inputs:** none.
- **Typical flow:** After a 403, before guessing which scope is missing.
- **Caveats:** Read-only. With `SENDGRID_ON_BEHALF_OF` set, scopes are evaluated for that subuser/customer account.

### `sendgrid_list_event_webhooks`
- **Purpose:** List Event Webhook configurations in SendGrid.
- **Inputs:** optional `includeAccountStatusChange`.
- **Typical flow:** Validate webhook fleet and event subscriptions.
- **Caveats:** Read-only inventory.

### `sendgrid_get_event_webhook`
- **Purpose:** Read one webhook configuration by ID.
- **Inputs:** `id`, optional include flag.
- **Typical flow:** Confirm exact event toggles and URL.
- **Caveats:** Requires valid webhook ID.

### `sendgrid_update_event_webhook`
- **Purpose:** Update webhook URL, enabled flag, and event toggles.
- **Inputs:** `id` + selected fields.
- **Typical flow:** Enable missing events / switch endpoint URL.
- **Caveats:** Signature mode is managed separately.

### `sendgrid_manage_event_webhook`
- **Purpose:** Create, delete, or test an Event Webhook (`POST /user/webhooks/event/settings`, `DELETE /user/webhooks/event/settings/{id}`, `POST /user/webhooks/event/test`).
- **Inputs:** `confirmToken="CONFIRM"`, `action` (`create` | `delete` | `test`), `url` for create, `id` for delete. Test uses `url`, or the saved webhook URL when only `id` is set. Optional event toggles match `update_event_webhook`.
- **Typical flow:** Point `url` at the local receiver, create, then test.
- **Caveats:** `oauth_client_secret` is redacted in the tool result. Delete does not remove the local receiver.

### `sendgrid_toggle_event_webhook_signature`
- **Purpose:** Enable/disable signed Event Webhook mode.
- **Inputs:** `id`, `enabled`.
- **Typical flow:** Enforce cryptographic source verification.
- **Caveats:** Public key changes can require receiver updates.

### `sendgrid_get_webhook_receiver_status`
- **Purpose:** Show local receiver runtime state and counters.
- **Inputs:** none.
- **Typical flow:** Verify receiver health after config or ngrok changes.
- **Caveats:** Local receiver must be enabled via env.

### `sendgrid_get_received_webhook_events`
- **Purpose:** Read buffered incoming Event Webhook payloads.
- **Inputs:** optional `limit`, `eventType`, `email`, `messageId`, `onlyVerified`.
- **Typical flow:** Incident reconstruction from near-real-time events.
- **Caveats:** In-memory buffer only; not persistent storage.

### `sendgrid_clear_received_webhook_events`
- **Purpose:** Clear local buffered webhook events.
- **Inputs:** `confirm=true`.
- **Typical flow:** Reset local buffer between test runs.
- **Caveats:** Irreversible in-memory clear.

---

## Account & Console Settings

### Runbook: Account Audit (read-only)

1. `sendgrid_get_account_info` + `sendgrid_get_user_credits`
2. `sendgrid_list_verified_senders` + `sendgrid_list_authenticated_domains` + `sendgrid_list_branded_links`
3. `sendgrid_list_mail_settings` / `sendgrid_list_tracking_settings` + targeted `get_*_setting`
4. `sendgrid_list_alerts` + `sendgrid_list_inbound_parse_settings`

### Runbook: Console Change (mutating)

1. Read current state with Phase 1 tools
2. Apply change with `confirmToken=CONFIRM` on mutating tool
3. Re-read setting and run delivery preflight if sender/domain related

### Phase 1 — Account read tools

All Phase 1 read tools return `structuredContent` + `outputSchema` (account/profile/credits as JSON records; list tools return `{ count, <items> }`).

- `sendgrid_get_account_info` — `GET /user/account`
- `sendgrid_get_user_profile` — `GET /user/profile`
- `sendgrid_get_user_credits` — `GET /user/credits`
- `sendgrid_list_verified_senders` / `sendgrid_get_verified_sender`
- `sendgrid_list_authenticated_domains` / `sendgrid_get_authenticated_domain`
- `sendgrid_list_branded_links` / `sendgrid_get_branded_link`
- `sendgrid_list_alerts` / `sendgrid_get_alert`
- `sendgrid_get_enforced_tls` — `GET /user/settings/enforced_tls`
- `sendgrid_list_mail_settings` / `sendgrid_get_mail_setting`
- `sendgrid_list_tracking_settings` / `sendgrid_get_tracking_setting`
- `sendgrid_list_inbound_parse_settings`

### Phase 2 — Console mutation tools

All mutating tools require `confirmToken: "CONFIRM"` (also stated in each tool's MCP `description`).

- `sendgrid_create_verified_sender` / `sendgrid_resend_verified_sender_verification` / `sendgrid_delete_verified_sender`
- `sendgrid_create_authenticated_domain` / `sendgrid_validate_authenticated_domain` / `sendgrid_validate_branded_link`
- `sendgrid_update_branded_link`
- `sendgrid_create_alert` / `sendgrid_update_alert` / `sendgrid_delete_alert`
- `sendgrid_update_mail_setting` — PATCH `/mail_settings/{name}`
- `sendgrid_update_tracking_setting` — PATCH `/tracking_settings/{name}`
- `sendgrid_create_inbound_parse_setting` / `sendgrid_update_inbound_parse_setting` / `sendgrid_delete_inbound_parse_setting`

**Caveats:** API key must include scopes for the target endpoint (e.g. `mail_settings.footer.update`, `tracking_settings.click.update`, `alerts.create`). Some settings are account-plan dependent.

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

---

## Risk Matrix

Risk levels:

- `read-only` — no mutation in SendGrid/local state
- `send` — can enqueue/send email
- `mutates-sendgrid` — changes remote SendGrid configuration/state
- `mutates-local` — changes local in-memory/buffer state

Tool risk classification:

- `sendgrid_list_templates`: `read-only`
- `sendgrid_rename_template`: `mutates-sendgrid`
- `sendgrid_rename_templates_bulk`: `mutates-sendgrid`
- `sendgrid_get_template_html`: `read-only`
- `sendgrid_create_template`: `mutates-sendgrid`
- `sendgrid_update_template_html`: `mutates-sendgrid`
- `sendgrid_activate_template_version`: `mutates-sendgrid`
- `sendgrid_prune_inactive_template_versions`: `mutates-sendgrid`
- `sendgrid_delete_template`: `mutates-sendgrid`
- `sendgrid_sync_template_ids`: `read-only`
- `sendgrid_validate_send_request`: `read-only`
- `sendgrid_send_with_preflight`: `send`
- `sendgrid_send_email_advanced`: `send`
- `sendgrid_send_template_email_advanced`: `send`
- `sendgrid_send_sandbox_email`: `send`
- `sendgrid_send_test_email`: `send`
- `sendgrid_create_batch_id`: `mutates-sendgrid`
- `sendgrid_list_scheduled_sends`: `read-only`
- `sendgrid_get_scheduled_send`: `read-only`
- `sendgrid_schedule_email`: `send`
- `sendgrid_pause_scheduled_send`: `mutates-sendgrid`
- `sendgrid_resume_scheduled_send`: `mutates-sendgrid`
- `sendgrid_cancel_scheduled_send`: `mutates-sendgrid`
- `sendgrid_search_message_activity`: `read-only`
- `sendgrid_search_email_logs`: `read-only`
- `sendgrid_get_message_activity`: `read-only`
- `sendgrid_list_event_webhooks`: `read-only`
- `sendgrid_get_event_webhook`: `read-only`
- `sendgrid_update_event_webhook`: `mutates-sendgrid`
- `sendgrid_toggle_event_webhook_signature`: `mutates-sendgrid`
- `sendgrid_manage_event_webhook`: `mutates-sendgrid`
- `sendgrid_get_webhook_receiver_status`: `read-only`
- `sendgrid_get_received_webhook_events`: `read-only`
- `sendgrid_clear_received_webhook_events`: `mutates-local`
- `sendgrid_classify_sendgrid_error`: `read-only`
- `sendgrid_triage_delivery_issue`: `read-only`
- `sendgrid_analyze_engagement_anomalies`: `read-only`
- `sendgrid_list_asm_groups`: `read-only`
- `sendgrid_create_asm_group`: `mutates-sendgrid`
- `sendgrid_list_categories`: `read-only`
- `sendgrid_list_suppressions`: `read-only`
- `sendgrid_check_suppression`: `read-only`
- `sendgrid_delete_suppression`: `mutates-sendgrid`
- `sendgrid_get_email_stats`: `read-only`
- `sendgrid_get_scopes`: `read-only`
- `sendgrid_list_subusers`: `read-only`
- `sendgrid_get_account_info`: `read-only`
- `sendgrid_get_user_profile`: `read-only`
- `sendgrid_get_user_credits`: `read-only`
- `sendgrid_list_verified_senders`: `read-only`
- `sendgrid_get_verified_sender`: `read-only`
- `sendgrid_list_authenticated_domains`: `read-only`
- `sendgrid_get_authenticated_domain`: `read-only`
- `sendgrid_list_branded_links`: `read-only`
- `sendgrid_get_branded_link`: `read-only`
- `sendgrid_list_alerts`: `read-only`
- `sendgrid_get_alert`: `read-only`
- `sendgrid_get_enforced_tls`: `read-only`
- `sendgrid_list_mail_settings`: `read-only`
- `sendgrid_get_mail_setting`: `read-only`
- `sendgrid_list_tracking_settings`: `read-only`
- `sendgrid_get_tracking_setting`: `read-only`
- `sendgrid_list_inbound_parse_settings`: `read-only`
- `sendgrid_create_verified_sender`: `mutates-sendgrid`
- `sendgrid_resend_verified_sender_verification`: `mutates-sendgrid`
- `sendgrid_delete_verified_sender`: `mutates-sendgrid`
- `sendgrid_create_authenticated_domain`: `mutates-sendgrid`
- `sendgrid_validate_authenticated_domain`: `mutates-sendgrid`
- `sendgrid_validate_branded_link`: `mutates-sendgrid`
- `sendgrid_update_branded_link`: `mutates-sendgrid`
- `sendgrid_create_alert`: `mutates-sendgrid`
- `sendgrid_update_alert`: `mutates-sendgrid`
- `sendgrid_delete_alert`: `mutates-sendgrid`
- `sendgrid_update_mail_setting`: `mutates-sendgrid`
- `sendgrid_update_tracking_setting`: `mutates-sendgrid`
- `sendgrid_create_inbound_parse_setting`: `mutates-sendgrid`
- `sendgrid_update_inbound_parse_setting`: `mutates-sendgrid`
- `sendgrid_delete_inbound_parse_setting`: `mutates-sendgrid`
