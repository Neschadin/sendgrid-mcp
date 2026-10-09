import { z } from 'zod';

const RegionSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['global', 'eu']));

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

const ConfigInputSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.email(),
  fromName: z.string().min(1).default('SendGrid MCP'),
  region: RegionSchema.default('global'),
  apiBaseUrl: HttpUrlSchema.optional(),
  onBehalfOf: z.string().trim().min(1).optional(),
});

export type AppConfig = z.output<typeof ConfigInputSchema> & {
  apiBaseUrl: string;
  preferEmailLogs: boolean;
};

const CONFIG_HELP = `SendGrid MCP credentials missing.

Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.
Optional: SENDGRID_REGION=global|eu (default global), SENDGRID_API_BASE_URL, SENDGRID_FROM_NAME, SENDGRID_ON_BEHALF_OF, READ_ONLY=true.`;

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(
  env: Record<string, string | undefined> = Bun.env,
): AppConfig {
  const apiKey = blankToUndefined(env['SENDGRID_API_KEY']);
  const fromEmail = blankToUndefined(env['SENDGRID_FROM_EMAIL']);
  if (!apiKey || !fromEmail) {
    throw new Error(CONFIG_HELP);
  }

  const region = blankToUndefined(env['SENDGRID_REGION']);
  const apiBaseUrl = blankToUndefined(env['SENDGRID_API_BASE_URL']);
  const fromName = blankToUndefined(env['SENDGRID_FROM_NAME']);
  const onBehalfOf = blankToUndefined(env['SENDGRID_ON_BEHALF_OF']);

  const parsed = ConfigInputSchema.safeParse({
    apiKey,
    fromEmail,
    ...(fromName ? { fromName } : {}),
    ...(region ? { region } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid SendGrid MCP config: ${z.prettifyError(parsed.error)}`,
    );
  }

  const resolvedBaseUrl =
    parsed.data.apiBaseUrl ??
    (parsed.data.region === 'eu'
      ? 'https://api.eu.sendgrid.com/v3'
      : 'https://api.sendgrid.com/v3');

  return {
    ...parsed.data,
    apiBaseUrl: resolvedBaseUrl.replace(/\/+$/u, ''),
    preferEmailLogs: parsed.data.region === 'eu',
  };
}

export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

export function buildServerInstructions(config: AppConfig): string {
  const behalf = config.onBehalfOf
    ? `on-behalf-of: ${config.onBehalfOf}`
    : 'on-behalf-of: not set';

  return `SendGrid MCP for transactional email, dynamic templates, delivery diagnostics, and console settings. Contact and list marketing CRUD is out of scope.

This instance: region ${config.region}, API ${config.apiBaseUrl}, from ${config.fromEmail}. ${behalf}.
READ_ONLY is checked on each call. When true, send and mutating tools return an error before any SendGrid request.

Workflow:
1. Safe send: sendgrid_validate_send_request, then sendgrid_send_with_preflight. sendgrid_send_email_advanced skips those checks.
2. POST /v3/mail/send returns x-message-id, which is not msg_id. Pass that header as xMessageId to sendgrid_search_message_activity (compiled to msg_id LIKE '<id>%'), then sendgrid_get_message_activity for the event chain (reason, bounce_type, asm_group_id, outbound_ip).
3. Delivery incident: search activity, sendgrid_check_suppression, sendgrid_triage_delivery_issue. Remove one suppression with sendgrid_delete_suppression and confirmToken "CONFIRM". GET /v3/messages has no offset. On Activity 403/404, and on an empty Activity result when region is eu, use Email Logs (sendgrid_search_email_logs).
4. 403: sendgrid_get_scopes. Email Activity may require the add-on. Browser, device, and client stats retain about 7 days.
5. Event Webhook config is in SendGrid. A local receiver exists only when SENDGRID_EVENT_WEBHOOK_PORT is set; its buffer is in-memory.
6. Mutating tools require confirmToken "CONFIRM". Tool arguments are rejected above ${MAX_TOOL_INPUT_ELEMENTS} combined array elements and object members. Responses redact oauth_client_secret and api_key values.`;
}
