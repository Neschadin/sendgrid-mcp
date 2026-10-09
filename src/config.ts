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

export type McpTransport = 'stdio' | 'http';
export type HttpAuthMode = 'token' | 'none';

export interface HttpEndpointConfig {
  host: string;
  port: number;
  authMode: HttpAuthMode;
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: boolean;
  tlsKeyFile?: string;
  tlsCertFile?: string;
}

export type AppConfig = z.output<typeof ConfigInputSchema> & {
  apiBaseUrl: string;
  preferEmailLogs: boolean;
  transport: McpTransport;
  http?: HttpEndpointConfig;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const CONFIG_HELP = `SendGrid MCP credentials missing.

Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.
Optional: SENDGRID_REGION=global|eu (default global), SENDGRID_API_BASE_URL, SENDGRID_FROM_NAME, SENDGRID_ON_BEHALF_OF, READ_ONLY=true.
Remote MCP: MCP_TRANSPORT=http, MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_AUTH_TOKEN.
Non-loopback HTTP requires MCP_AUTH_TOKEN and either TLS files or MCP_TRUST_PROXY=true.`;

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

  const transport = resolveTransport(env);
  const http = transport === 'http' ? resolveHttpEndpoint(env) : undefined;

  return {
    ...parsed.data,
    apiBaseUrl: resolvedBaseUrl.replace(/\/+$/u, ''),
    preferEmailLogs: parsed.data.region === 'eu',
    transport,
    ...(http ? { http } : {}),
  };
}

function resolveTransport(env: Record<string, string | undefined>): McpTransport {
  const raw = blankToUndefined(env['MCP_TRANSPORT'])?.toLowerCase() ?? 'stdio';
  if (raw === 'stdio' || raw === 'http') return raw;
  throw new Error('MCP_TRANSPORT must be stdio or http');
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveHttpEndpoint(
  env: Record<string, string | undefined>,
): HttpEndpointConfig {
  const host = blankToUndefined(env['MCP_HTTP_HOST']) ?? '127.0.0.1';
  const portRaw = blankToUndefined(env['MCP_HTTP_PORT']) ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MCP_HTTP_PORT must be an integer from 1 to 65535');
  }

  const authRaw = blankToUndefined(env['MCP_AUTH_MODE'])?.toLowerCase() ?? 'token';
  if (authRaw !== 'token' && authRaw !== 'none') {
    throw new Error('MCP_AUTH_MODE must be token or none');
  }
  const authToken = blankToUndefined(env['MCP_AUTH_TOKEN']);
  const loopback = LOOPBACK_HOSTS.has(host);
  if (authRaw === 'none' && !loopback) {
    throw new Error(
      'MCP_AUTH_MODE=none is only allowed when MCP_HTTP_HOST is loopback. Set MCP_AUTH_TOKEN.',
    );
  }
  if (authRaw === 'token' && !authToken) {
    throw new Error('MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http and MCP_AUTH_MODE=token');
  }

  const tlsKeyFile = blankToUndefined(env['MCP_TLS_KEY_FILE']);
  const tlsCertFile = blankToUndefined(env['MCP_TLS_CERT_FILE']);
  if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) {
    throw new Error('MCP_TLS_KEY_FILE and MCP_TLS_CERT_FILE must be set together');
  }
  const trustProxy = ['1', 'true', 'yes', 'on'].includes(
    blankToUndefined(env['MCP_TRUST_PROXY'])?.toLowerCase() ?? '',
  );
  if (!loopback && !tlsKeyFile && !trustProxy) {
    throw new Error(
      `Refusing plaintext HTTP on ${host}. Set MCP_TLS_KEY_FILE and MCP_TLS_CERT_FILE, or MCP_TRUST_PROXY=true behind a TLS proxy.`,
    );
  }

  const allowedHosts = splitList(env['MCP_ALLOWED_HOSTS']);
  const allowedOrigins = splitList(env['MCP_ALLOWED_ORIGINS']);
  if (!loopback && allowedHosts.length === 0) {
    throw new Error(
      'MCP_ALLOWED_HOSTS is required when MCP_HTTP_HOST is not loopback',
    );
  }

  return {
    host,
    port,
    authMode: authRaw,
    ...(authToken ? { authToken } : {}),
    allowedHosts,
    allowedOrigins,
    trustProxy,
    ...(tlsKeyFile ? { tlsKeyFile } : {}),
    ...(tlsCertFile ? { tlsCertFile } : {}),
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
6. Mutating tools require confirmToken "CONFIRM". Tool arguments are rejected above ${MAX_TOOL_INPUT_ELEMENTS} combined array elements and object members. Responses redact oauth_client_secret and api_key values.
7. Subusers: sendgrid_list_subusers, then pass username as onBehalfOf. onBehalfOf="parent" ignores SENDGRID_ON_BEHALF_OF for that call.
8. Event Webhooks: list/get/update/toggle, or sendgrid_manage_event_webhook with action create|delete|test and confirmToken "CONFIRM".
9. Transport: ${config.transport}${config.http ? ` at ${config.http.host}:${config.http.port}/mcp (${config.http.authMode} auth)` : ''}.`;
}
