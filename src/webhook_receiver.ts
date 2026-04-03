import { createVerify } from 'node:crypto';

export interface ReceivedWebhookEvent {
  receivedAt: string;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
}

export interface WebhookReceiverStatus {
  enabled: boolean;
  listening: boolean;
  host?: string;
  port?: number;
  path?: string;
  maxStoredEvents: number;
  storedEvents: number;
  eventTypeBreakdown: Record<string, number>;
  signatureRequired: boolean;
  signatureConfigured: boolean;
  lastReceivedAt?: string;
  lastError?: string;
}

interface ReceiverRuntime {
  host: string;
  port: number;
  path: string;
  healthPath: string;
  verbose: boolean;
  signatureRequired: boolean;
  publicKey?: string;
  maxStoredEvents: number;
}

let runtime: ReceiverRuntime | undefined;
let listening = false;
let lastError: string | undefined;
const storedEvents: ReceivedWebhookEvent[] = [];

function parseBooleanEnv(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (!value) return defaultValue;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizePublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return trimmed;

  const base64Body = trimmed.replace(/\s+/gu, '');
  const chunks = base64Body.match(/.{1,64}/gu) ?? [];
  return [
    '-----BEGIN PUBLIC KEY-----',
    ...chunks,
    '-----END PUBLIC KEY-----',
  ].join('\n');
}

function verifyWebhookSignature(params: {
  payloadBytes: Buffer;
  timestamp: string;
  signatureBase64: string;
  publicKey: string;
}): boolean {
  const verifier = createVerify('sha256');
  verifier.update(Buffer.from(params.timestamp, 'utf8'));
  verifier.update(params.payloadBytes);
  verifier.end();

  const signature = Buffer.from(params.signatureBase64, 'base64');
  const pem = normalizePublicKey(params.publicKey);
  return verifier.verify(pem, signature);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventTypeOf(payload: Record<string, unknown>): string {
  const rawEvent = payload['event'];
  if (typeof rawEvent === 'string' && rawEvent.trim().length > 0) {
    return rawEvent.trim().toLowerCase();
  }
  return 'unknown';
}

/**
 * Truncated User-Agent for log lines. MCP stdio uses stdout for JSON-RPC only,
 * so info logs use stderr — many IDEs label that stream as `[error]` even when it is not a failure.
 */
function formatUaSuffix(request: Request): string {
  const ua = request.headers.get('user-agent') ?? '';
  const uaShort = ua.length > 96 ? `${ua.slice(0, 93)}...` : ua;
  return uaShort ? ` ua=${JSON.stringify(uaShort)}` : '';
}

function logWebhookTraffic(
  runtime: ReceiverRuntime,
  label: string,
  request: Request,
  extra?: string,
) {
  if (!runtime.verbose) return;
  const pathname = new URL(request.url).pathname;
  process.stderr.write(
    `[sendgrid-mcp] webhook ${label} ${request.method} ${pathname}` +
      formatUaSuffix(request) +
      (extra ? ` | ${extra}` : '') +
      '\n',
  );
}

function formatKeyValueBlock(fields: Array<[string, string]>): string {
  const maxKey = fields.reduce((m, [k]) => Math.max(m, k.length), 0);
  return fields
    .map(([k, v]) => `  ${k.padEnd(maxKey, ' ')}  ${v}`)
    .join('\n');
}

function pushStoredEvents(
  events: ReceivedWebhookEvent[],
  maxStoredEvents: number,
) {
  if (events.length === 0) return;
  storedEvents.push(...events);
  if (storedEvents.length > maxStoredEvents) {
    const overflow = storedEvents.length - maxStoredEvents;
    storedEvents.splice(0, overflow);
  }
}

export function startWebhookReceiverFromEnv() {
  const verbose = parseBooleanEnv(
    process.env['SENDGRID_EVENT_WEBHOOK_VERBOSE'],
    false,
  );
  const portRaw = process.env['SENDGRID_EVENT_WEBHOOK_PORT'];
  if (!portRaw || portRaw.trim().length === 0) {
    if (verbose) {
      process.stderr.write(
        '[sendgrid-mcp] Webhook receiver disabled (SENDGRID_EVENT_WEBHOOK_PORT not set)\n',
      );
    }
    return;
  }
  if (listening) return;

  const parsedPort = Number(portRaw);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    throw new Error(
      `Invalid SENDGRID_EVENT_WEBHOOK_PORT: "${portRaw}". Expected positive integer.`,
    );
  }

  const host = process.env['SENDGRID_EVENT_WEBHOOK_HOST']?.trim() || '0.0.0.0';
  const path =
    process.env['SENDGRID_EVENT_WEBHOOK_PATH']?.trim() || '/sendgrid/events';
  const healthPath =
    process.env['SENDGRID_EVENT_WEBHOOK_HEALTH_PATH']?.trim() ||
    '/sendgrid/events/health';
  const signatureRequired = parseBooleanEnv(
    process.env['SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE'],
    false,
  );
  const publicKey = process.env['SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY']?.trim();
  const maxStoredEvents = Math.max(
    100,
    Number(process.env['SENDGRID_EVENT_WEBHOOK_MAX_EVENTS'] ?? '5000') || 5000,
  );

  if (signatureRequired && !publicKey) {
    throw new Error(
      'SENDGRID_EVENT_WEBHOOK_REQUIRE_SIGNATURE=true requires SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY.',
    );
  }

  runtime = {
    host,
    port: parsedPort,
    path,
    healthPath,
    verbose,
    signatureRequired,
    publicKey,
    maxStoredEvents,
  };

  Bun.serve({
    hostname: host,
    port: parsedPort,
    fetch: async (request) => {
      if (!runtime) {
        return new Response('Receiver runtime missing', { status: 500 });
      }

      const url = new URL(request.url);
      if (url.pathname === runtime.healthPath) {
        logWebhookTraffic(
          runtime,
          'health',
          request,
          request.method === 'GET' ? '200' : '405 expected GET',
        );
        if (request.method === 'GET') {
          return new Response(
            JSON.stringify(getWebhookReceiverStatus(), null, 2),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return new Response('Method Not Allowed', { status: 405 });
      }

      if (url.pathname !== runtime.path) {
        return new Response('Not found', { status: 404 });
      }

      const uaSuffix = formatUaSuffix(request);

      if (request.method !== 'POST') {
        if (runtime.verbose) {
          process.stderr.write(
            `[sendgrid-mcp] webhook event ${request.method} ${runtime.path}${uaSuffix} -> 405 (expected POST)\n`,
          );
        }
        return new Response('Method Not Allowed', { status: 405 });
      }

      try {
        const payloadBytes = Buffer.from(await request.arrayBuffer());
        const payloadText = payloadBytes.toString('utf8');
        const signature = request.headers.get(
          'x-twilio-email-event-webhook-signature',
        );
        const timestamp = request.headers.get(
          'x-twilio-email-event-webhook-timestamp',
        );

        let signatureVerified = false;
        if (runtime.publicKey && signature && timestamp) {
          signatureVerified = verifyWebhookSignature({
            payloadBytes,
            timestamp,
            signatureBase64: signature,
            publicKey: runtime.publicKey,
          });
        } else if (!runtime.publicKey && !runtime.signatureRequired) {
          signatureVerified = false;
        }

        if (runtime.signatureRequired && !signatureVerified) {
          lastError =
            'Signature verification failed for incoming webhook payload.';
          if (runtime.verbose) {
            process.stderr.write(
              `[sendgrid-mcp] webhook event POST ${runtime.path}${uaSuffix} -> 401 signature_verify failed bytes=${payloadBytes.length}\n`,
            );
          }
          return new Response(
            JSON.stringify({ error: 'invalid webhook signature' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }

        const parsed = JSON.parse(payloadText) as unknown;
        const records = Array.isArray(parsed) ? parsed : [parsed];
        const normalized = records
          .map(toRecord)
          .filter(
            (record): record is Record<string, unknown> => record !== undefined,
          )
          .map((record) => ({
            receivedAt: new Date().toISOString(),
            signatureVerified,
            payload: record,
          }));

        pushStoredEvents(normalized, runtime.maxStoredEvents);
        lastError = undefined;

        if (runtime.verbose) {
          const types = normalized.map((item) => eventTypeOf(item.payload));
          const typeSummary = types.reduce<Record<string, number>>((acc, t) => {
            acc[t] = (acc[t] ?? 0) + 1;
            return acc;
          }, {});
          process.stderr.write(
            [
              `[sendgrid-mcp] webhook event POST ${runtime.path}${uaSuffix} -> 200`,
              formatKeyValueBlock([
                ['accepted', String(normalized.length)],
                ['signatureVerified', signatureVerified ? 'true' : 'false'],
                ['bytes', String(payloadBytes.length)],
                ['types', JSON.stringify(typeSummary)],
              ]),
              '',
            ].join('\n'),
          );
        }

        return new Response(
          JSON.stringify({
            accepted: normalized.length,
            signatureVerified,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      } catch (error) {
        lastError = String(error);
        if (runtime.verbose) {
          process.stderr.write(
            `[sendgrid-mcp] webhook event POST ${runtime.path}${uaSuffix} -> 400 parse error: ${lastError}\n`,
          );
        }
        return new Response(
          JSON.stringify({
            error: 'invalid webhook payload',
            details: lastError,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
    },
  });

  listening = true;

  if (verbose) {
    process.stderr.write(
      [
        '[sendgrid-mcp] Webhook receiver started',
        `  listen:  http://${host}:${parsedPort}${path}`,
        `  health:  http://${host}:${parsedPort}${healthPath}`,
        `  signed:  required=${signatureRequired ? 'yes' : 'no'} configured=${publicKey ? 'yes' : 'no'}`,
        `  buffer:  maxEvents=${maxStoredEvents}`,
      ].join('\n') + '\n',
    );
  }
}

export function getWebhookReceiverStatus(): WebhookReceiverStatus {
  const breakdown: Record<string, number> = {};
  for (const event of storedEvents) {
    const type = eventTypeOf(event.payload);
    breakdown[type] = (breakdown[type] ?? 0) + 1;
  }

  return {
    enabled: runtime !== undefined,
    listening,
    host: runtime?.host,
    port: runtime?.port,
    path: runtime?.path,
    maxStoredEvents: runtime?.maxStoredEvents ?? 0,
    storedEvents: storedEvents.length,
    eventTypeBreakdown: breakdown,
    signatureRequired: runtime?.signatureRequired ?? false,
    signatureConfigured: Boolean(runtime?.publicKey),
    lastReceivedAt: storedEvents[storedEvents.length - 1]?.receivedAt,
    lastError,
  };
}

export function getStoredWebhookEvents(params?: {
  limit?: number;
  eventType?: string;
  email?: string;
  messageId?: string;
  onlyVerified?: boolean;
}): ReceivedWebhookEvent[] {
  const limit = Math.max(1, Math.min(params?.limit ?? 50, 5000));
  const eventType = params?.eventType?.trim().toLowerCase();
  const email = params?.email?.trim().toLowerCase();
  const messageId = params?.messageId?.trim().toLowerCase();

  const filtered = storedEvents.filter((item) => {
    if (params?.onlyVerified && !item.signatureVerified) return false;

    if (eventType) {
      const current = eventTypeOf(item.payload);
      if (current !== eventType) return false;
    }

    if (email) {
      const payloadEmail = item.payload['email'];
      if (
        typeof payloadEmail !== 'string' ||
        payloadEmail.toLowerCase() !== email
      ) {
        return false;
      }
    }

    if (messageId) {
      const msg = item.payload['sg_message_id'];
      if (typeof msg !== 'string' || !msg.toLowerCase().includes(messageId)) {
        return false;
      }
    }

    return true;
  });

  return filtered.slice(-limit).reverse();
}

export function clearStoredWebhookEvents() {
  storedEvents.length = 0;
}
