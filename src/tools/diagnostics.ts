import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isSendGridApiError, type SendGridClient } from '../client';
import {
  ensureSafeToolRegistration,
  formatToolError,
  ListPagingInputFields,
  ReadInputFields,
  ResponseFormatSchema,
} from './tool_utils';
import {
  AnalyzeEngagementOutputSchema,
  AsmGroupListOutputSchema,
  AsmGroupSchema,
  AsmGroupSuppressionSchema,
  CategoryListOutputSchema,
  ClassifyErrorOutputSchema,
  DeleteSuppressionOutputSchema,
  EmailLogsOutputSchema,
  EmailStatsOutputSchema,
  EventWebhookListOutputSchema,
  EventWebhookSchema,
  ManageEventWebhookOutputSchema,
  ListSuppressionsOutputSchema,
  MessageActivitySchema,
  ReceivedWebhookEventsOutputSchema,
  SearchMessageActivityOutputSchema,
  StatsDimensionSchema,
  TriageDeliveryOutputSchema,
  WebhookReceiverStatusOutputSchema,
  buildPaginationMeta,
  jsonReadResult,
  paginateArray,
} from './output_schemas';
import {
  activityListMeta,
  compileActivitySearch,
  rejectActivityOffset,
  searchActivityOrLogs,
  summarizeActivityMessage,
  traceMessage,
} from './delivery_trace';
import {
  clearStoredWebhookEvents,
  getStoredWebhookEvents,
  getWebhookReceiverStatus,
} from '../webhook_receiver';
import { classifySendGridError } from './classify_error';

type EngagementEvent = {
  event: string;
  email?: string;
  timestamp?: number;
  ip?: string;
  useragent?: string;
  sg_machine_open?: boolean;
  sg_message_id?: string;
};

const ConfirmTokenSchema = z
  .literal('CONFIRM')
  .describe('Required confirmation token');

const SHORT_STATS_WINDOW = new Set(['browser', 'device', 'client']);

function collectStatTotals(payload: unknown): {
  totals: { requests: number; delivered: number; bounces: number; opens: number };
  lines: string[];
} {
  const totals = { requests: 0, delivered: 0, bounces: 0, opens: 0 };
  const lines: string[] = [];
  const visit = (value: unknown, prefix: string) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, prefix);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const date = typeof record['date'] === 'string' ? record['date'] : prefix;
    const name = typeof record['name'] === 'string' ? record['name'] : undefined;
    const metrics = record['metrics'];
    if (metrics && typeof metrics === 'object') {
      const metric = metrics as Record<string, unknown>;
      if (typeof metric['requests'] === 'number') {
        const delivered =
          typeof metric['delivered'] === 'number' ? metric['delivered'] : 0;
        const bounces =
          typeof metric['bounces'] === 'number' ? metric['bounces'] : 0;
        const opens = typeof metric['opens'] === 'number' ? metric['opens'] : 0;
        totals.requests += metric['requests'];
        totals.delivered += delivered;
        totals.bounces += bounces;
        totals.opens += opens;
        const label = [date, name].filter((part) => part && part.length > 0).join(' ');
        lines.push(
          `${label}: requests=${metric['requests']} delivered=${delivered} bounces=${bounces} opens=${opens}`,
        );
      }
    }
    if (Array.isArray(record['stats'])) visit(record['stats'], date);
  };
  visit(payload, '');
  return { totals, lines };
}

function asStatsSeries(payload: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const series = payload.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item),
  );
  return series.length > 0 ? series : undefined;
}

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    );
  }, 'Invalid calendar date');

function domainFromEmail(email?: string): string {
  if (!email) return '';
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function summarizeRates(requests: number, delivered: number): string {
  if (requests === 0) return '0%';
  return `${((delivered / requests) * 100).toFixed(1)}%`;
}

function findTopCount(
  values: string[],
): { value: string; count: number } | undefined {
  if (values.length === 0) return undefined;
  const map = new Map<string, number>();
  for (const value of values) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }

  let top: { value: string; count: number } | undefined;
  for (const [value, count] of map.entries()) {
    if (!top || count > top.count) top = { value, count };
  }
  return top;
}

export function registerDiagnosticsTools(
  server: McpServer,
  client: SendGridClient,
) {
  ensureSafeToolRegistration(server);
  server.registerTool(
    'search_message_activity',
    {
      description:
        'Search SendGrid Email Activity (GET /v3/messages). Pass xMessageId for the Mail Send x-message-id header; it is compiled to msg_id LIKE. offset is not supported by this API. On 403/404, or an empty EU Activity result, falls back to POST /v3/logs.',
      inputSchema: z
        .object({
          query: z
            .string()
            .min(1)
            .optional()
            .describe(
              'SendGrid Email Activity query, e.g. from_email="ops@acme.com" AND to_email="user@acme.com"',
            ),
          xMessageId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'x-message-id from the POST /v3/mail/send response header. Compiled to msg_id LIKE \'<id>%\'. This is not the full msg_id.',
            ),
          limit: z.number().int().min(1).max(1000).optional(),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Not supported by GET /v3/messages. Values above 0 return an error. Narrow the query instead.',
            ),
          response_format: ResponseFormatSchema.optional(),
        })
        .superRefine((value, ctx) => {
          if (!value.query && !value.xMessageId) {
            ctx.addIssue({
              code: 'custom',
              message: 'Provide query or xMessageId',
              path: ['query'],
            });
          }
        }),
      outputSchema: SearchMessageActivityOutputSchema,
    },
    async ({ query, xMessageId, limit, offset, response_format }) => {
      try {
        rejectActivityOffset(offset);
        const pageLimit = limit ?? 25;
        const compiled = compileActivitySearch({ query, xMessageId });
        const found = await searchActivityOrLogs(client, compiled, pageLimit);
        const messages = found.messages;
        const pagination = activityListMeta(messages.length, pageLimit);
        const notes = [found.note, pagination.note].filter(
          (item): item is string => typeof item === 'string',
        );
        const rows = messages.map((message) => summarizeActivityMessage(message));
        const body =
          rows.length === 0
            ? `No messages matched query: ${compiled}`
            : [
                `Matched messages: ${rows.length}`,
                `Source: ${found.source}`,
                '',
                ...rows.map((row) => `- ${row}`),
              ].join('\n');

        return jsonReadResult(
          {
            total_count: pagination.total_count,
            count: pagination.count,
            offset: pagination.offset,
            has_more: pagination.has_more,
            next_offset: pagination.next_offset,
            messages,
            source: found.source,
            ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
          },
          [...notes, ...(notes.length > 0 ? [''] : []), body].join('\n'),
          response_format,
        );
      } catch (error) {
        if (isSendGridApiError(error)) {
          const addonHint =
            error.status === 403 || error.status === 404
              ? '\nHint: Email Activity API may require the Email Activity add-on.'
              : '';
          throw new Error(
            `Failed to query Email Activity API.${addonHint}\n${formatToolError(error)}`,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'get_message_activity',
    {
      description:
        'Get Email Activity for one message. msgId may be a full msg_id or the Mail Send x-message-id (resolved with msg_id LIKE). On Activity 403/404 for a full id, falls back to POST /v3/logs.',
      inputSchema: z.object({
        msgId: z.string().min(1),
        ...ReadInputFields,
      }),
      outputSchema: MessageActivitySchema,
    },
    async ({ msgId, response_format }) => {
      try {
        const traced = await traceMessage(client, msgId);
        const summary = summarizeActivityMessage(traced.message);
        return jsonReadResult(
          traced.message,
          [summary, ...(traced.note ? ['', traced.note] : []), '', JSON.stringify(traced.message, null, 2)].join('\n'),
          response_format,
        );
      } catch (error) {
        if (isSendGridApiError(error)) {
          const addonHint =
            error.status === 403 || error.status === 404
              ? '\nHint: Email Activity API access may be unavailable without add-on.'
              : '';
          throw new Error(
            `Failed to load message activity.${addonHint}\n${formatToolError(error)}`,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'list_event_webhooks',
    {
      description:
        'List all Event Webhook configurations directly from SendGrid.',
      inputSchema: z.object({
        includeAccountStatusChange: z.boolean().optional(),
        ...ListPagingInputFields,
      }),
      outputSchema: EventWebhookListOutputSchema,
    },
    async ({ includeAccountStatusChange, limit, offset, response_format }) => {
      const response = await client.getAllEventWebhooks(
        includeAccountStatusChange ?? false,
      );
      const webhooks = response.webhooks ?? [];
      const { items, pagination } = paginateArray(webhooks, limit, offset);
      const rows = items.map((webhook) => {
        return [
          `- id=${webhook.id ?? 'n/a'}`,
          `enabled=${String(webhook.enabled ?? false)}`,
          `url=${String(webhook.url ?? 'n/a')}`,
          `delivered=${String(webhook.delivered ?? false)}`,
          `bounce=${String(webhook.bounce ?? false)}`,
          `deferred=${String(webhook.deferred ?? false)}`,
          `dropped=${String(webhook.dropped ?? false)}`,
          `open=${String(webhook.open ?? false)}`,
          `click=${String(webhook.click ?? false)}`,
          `public_key=${webhook.public_key ? 'set' : 'not-set'}`,
        ].join(' | ');
      });

      return jsonReadResult(
        {
          ...pagination,
          maxAllowed: response.max_allowed ?? null,
          webhooks: items,
        },
        rows.length === 0
          ? 'No event webhooks found.'
          : [
              `Max allowed webhooks: ${response.max_allowed ?? 'n/a'}`,
              `Configured webhooks: ${pagination.total_count}`,
              '',
              ...rows,
            ].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'get_event_webhook',
    {
      description: 'Get one Event Webhook config by ID from SendGrid.',
      inputSchema: z.object({
        id: z.string().min(1),
        includeAccountStatusChange: z.boolean().optional(),
        ...ReadInputFields,
      }),
      outputSchema: EventWebhookSchema,
    },
    async ({ id, includeAccountStatusChange, response_format }) => {
      const webhook = await client.getEventWebhook(
        id,
        includeAccountStatusChange ?? false,
      );
      return jsonReadResult(webhook, JSON.stringify(webhook, null, 2), response_format);
    },
  );

  server.registerTool(
    'update_event_webhook',
    {
      description:
        'Update Event Webhook settings in SendGrid (URL, enabled flag, and event toggles).',
      inputSchema: z.object({
        confirmToken: z
          .literal('CONFIRM')
          .describe('Safety token required for mutating webhook settings'),
        id: z.string().min(1),
        includeAccountStatusChange: z.boolean().optional(),
        enabled: z.boolean().optional(),
        url: z.url().optional(),
        accountStatusChange: z.boolean().optional(),
        groupResubscribe: z.boolean().optional(),
        delivered: z.boolean().optional(),
        groupUnsubscribe: z.boolean().optional(),
        spamReport: z.boolean().optional(),
        bounce: z.boolean().optional(),
        deferred: z.boolean().optional(),
        unsubscribe: z.boolean().optional(),
        processed: z.boolean().optional(),
        open: z.boolean().optional(),
        click: z.boolean().optional(),
        dropped: z.boolean().optional(),
        friendlyName: z.string().nullable().optional(),
        oauthClientId: z.string().nullable().optional(),
        oauthClientSecret: z.string().nullable().optional(),
        oauthTokenUrl: z.string().nullable().optional(),
      }),
    },
    async ({
      id,
      includeAccountStatusChange,
      enabled,
      url,
      accountStatusChange,
      groupResubscribe,
      delivered,
      groupUnsubscribe,
      spamReport,
      bounce,
      deferred,
      unsubscribe,
      processed,
      open,
      click,
      dropped,
      friendlyName,
      oauthClientId,
      oauthClientSecret,
      oauthTokenUrl,
    }) => {
      const updated = await client.updateEventWebhook(
        id,
        {
          enabled,
          url,
          account_status_change: accountStatusChange,
          group_resubscribe: groupResubscribe,
          delivered,
          group_unsubscribe: groupUnsubscribe,
          spam_report: spamReport,
          bounce,
          deferred,
          unsubscribe,
          processed,
          open,
          click,
          dropped,
          friendly_name: friendlyName,
          oauth_client_id: oauthClientId ?? undefined,
          oauth_client_secret: oauthClientSecret ?? undefined,
          oauth_token_url: oauthTokenUrl ?? undefined,
        },
        includeAccountStatusChange ?? false,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  server.registerTool(
    'toggle_event_webhook_signature',
    {
      description:
        'Enable or disable SendGrid signature verification for a specific Event Webhook.',
      inputSchema: z.object({
        confirmToken: z
          .literal('CONFIRM')
          .describe('Safety token required for mutating webhook settings'),
        id: z.string().min(1),
        enabled: z.boolean(),
      }),
    },
    async ({ id, enabled }) => {
      const response = await client.toggleEventWebhookSignatureVerification(
        id,
        enabled,
      );
      return {
        content: [
          {
            type: 'text',
            text: [
              `Webhook ID: ${response.id}`,
              `Signature verification: ${enabled ? 'enabled' : 'disabled'}`,
              `Public key: ${response.public_key ? 'present' : 'not present'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  const WebhookEventFields = {
    enabled: z.boolean().optional(),
    friendlyName: z.string().nullable().optional(),
    bounce: z.boolean().optional(),
    click: z.boolean().optional(),
    deferred: z.boolean().optional(),
    delivered: z.boolean().optional(),
    dropped: z.boolean().optional(),
    groupResubscribe: z.boolean().optional(),
    groupUnsubscribe: z.boolean().optional(),
    open: z.boolean().optional(),
    processed: z.boolean().optional(),
    spamReport: z.boolean().optional(),
    unsubscribe: z.boolean().optional(),
    oauthClientId: z.string().nullable().optional(),
    oauthClientSecret: z.string().nullable().optional(),
    oauthTokenUrl: z.string().nullable().optional(),
  };

  server.registerTool(
    'manage_event_webhook',
    {
      description:
        'Create, delete, or test a SendGrid Event Webhook. create requires url. delete requires id. test sends a sample event to url, or to the saved webhook url when only id is set.',
      inputSchema: z
        .object({
          confirmToken: ConfirmTokenSchema,
          action: z.enum(['create', 'delete', 'test']),
          id: z.string().min(1).optional(),
          url: z.url().optional(),
          ...WebhookEventFields,
        })
        .superRefine((value, ctx) => {
          if (value.action === 'create' && !value.url) {
            ctx.addIssue({
              code: 'custom',
              message: 'url is required when action is create',
              path: ['url'],
            });
          }
          if (value.action === 'delete' && !value.id) {
            ctx.addIssue({
              code: 'custom',
              message: 'id is required when action is delete',
              path: ['id'],
            });
          }
          if (value.action === 'test' && !value.url && !value.id) {
            ctx.addIssue({
              code: 'custom',
              message: 'test requires url or id',
              path: ['url'],
            });
          }
        }),
      outputSchema: ManageEventWebhookOutputSchema,
    },
    async ({
      action,
      id,
      url,
      enabled,
      friendlyName,
      bounce,
      click,
      deferred,
      delivered,
      dropped,
      groupResubscribe,
      groupUnsubscribe,
      open,
      processed,
      spamReport,
      unsubscribe,
      oauthClientId,
      oauthClientSecret,
      oauthTokenUrl,
    }) => {
      const eventPayload = {
        enabled,
        friendly_name: friendlyName,
        bounce,
        click,
        deferred,
        delivered,
        dropped,
        group_resubscribe: groupResubscribe,
        group_unsubscribe: groupUnsubscribe,
        open,
        processed,
        spam_report: spamReport,
        unsubscribe,
        oauth_client_id: oauthClientId ?? undefined,
        oauth_client_secret: oauthClientSecret ?? undefined,
        oauth_token_url: oauthTokenUrl ?? undefined,
      };

      if (action === 'delete') {
        await client.deleteEventWebhook(id!);
        return jsonReadResult(
          { action, id: id ?? null, url: null },
          `Deleted Event Webhook ${id}.`,
        );
      }

      let targetUrl = url;
      if (action === 'test' && !targetUrl && id) {
        const existing = await client.getEventWebhook(id);
        targetUrl = existing.url;
      }
      if (!targetUrl) {
        throw new Error('Event Webhook url is missing.');
      }

      if (action === 'create') {
        const webhook = await client.createEventWebhook({
          ...eventPayload,
          url: targetUrl,
        });
        return jsonReadResult(
          { action, id: webhook.id ?? null, url: webhook.url ?? targetUrl, webhook },
          `Created Event Webhook ${webhook.id} -> ${webhook.url ?? targetUrl}`,
        );
      }

      await client.testEventWebhook({ url: targetUrl, id });
      return jsonReadResult(
        { action, id: id ?? null, url: targetUrl },
        `Sent Event Webhook test notification to ${targetUrl}.`,
      );
    },
  );

  server.registerTool(
    'get_webhook_receiver_status',
    {
      description:
        'Show local webhook receiver status for incoming SendGrid Event Webhook posts.',
      inputSchema: z.object({ ...ReadInputFields }),
      outputSchema: WebhookReceiverStatusOutputSchema,
    },
    async ({ response_format }) => {
      const status = getWebhookReceiverStatus();
      return jsonReadResult(status, JSON.stringify(status, null, 2), response_format);
    },
  );

  server.registerTool(
    'get_received_webhook_events',
    {
      description:
        'Read recent Event Webhook payloads captured by this server (for SendGrid-side diagnostics).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(5000).optional(),
        eventType: z.string().optional(),
        email: z.email().optional(),
        messageId: z.string().optional(),
        onlyVerified: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        response_format: ResponseFormatSchema.optional(),
      }),
      outputSchema: ReceivedWebhookEventsOutputSchema,
    },
    async ({
      limit,
      offset,
      eventType,
      email,
      messageId,
      onlyVerified,
      response_format,
    }) => {
      const events = getStoredWebhookEvents({
        limit,
        eventType,
        email,
        messageId,
        onlyVerified,
      });
      const pageOffset = offset ?? 0;
      const pagination = buildPaginationMeta({
        totalCount: events.length + pageOffset,
        count: events.length,
        offset: pageOffset,
      });

      return jsonReadResult(
        { ...pagination, events },
        events.length === 0
          ? 'No matching webhook events captured.'
          : JSON.stringify(events, null, 2),
        response_format,
      );
    },
  );

  server.registerTool(
    'clear_received_webhook_events',
    {
      description: 'Clear locally captured SendGrid Event Webhook payloads.',
      inputSchema: z.object({
        confirm: z
          .boolean()
          .describe('Safety switch: must be true to clear buffered events'),
      }),
    },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text',
              text: 'Skipped. Set confirm=true to clear captured events.',
            },
          ],
        };
      }
      clearStoredWebhookEvents();
      return {
        content: [{ type: 'text', text: 'Captured webhook events cleared.' }],
      };
    },
  );

  server.registerTool(
    'classify_sendgrid_error',
    {
      description:
        'Classify SendGrid API errors and return likely causes with targeted remediation steps.',
      inputSchema: z
        .object({
          statusCode: z.number().int().optional(),
          errorMessage: z.string().optional(),
          rawBody: z.string().optional(),
          ...ReadInputFields,
        })
        .refine(
          (value) =>
            value.statusCode !== undefined ||
            (value.errorMessage?.trim().length ?? 0) > 0 ||
            (value.rawBody?.trim().length ?? 0) > 0,
          'Provide at least one of statusCode, errorMessage, or rawBody.',
        ),
      outputSchema: ClassifyErrorOutputSchema,
    },
    async ({ statusCode, errorMessage, rawBody, response_format }) => {
      const text = normalize(`${errorMessage ?? ''}\n${rawBody ?? ''}`);
      const classified = classifySendGridError(statusCode, text);
      const structured = {
        category: classified.category,
        statusCode: statusCode ?? null,
        probableCauses: classified.probableCauses,
        actions: classified.actions,
      };

      return jsonReadResult(
        structured,
        [
          `Category: ${classified.category}`,
          `Status code: ${statusCode ?? 'unknown'}`,
          '',
          'Probable causes:',
          ...classified.probableCauses.map((cause) => `- ${cause}`),
          '',
          'Recommended actions:',
          ...classified.actions.map((action) => `- ${action}`),
        ].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'triage_delivery_issue',
    {
      description:
        'Run targeted delivery triage for common incidents (202 accepted no inbox, processing, sender identity, DMARC/auth, template drops, deferrals, unsubscribe spikes).',
      inputSchema: z.object({
        scenario: z.enum([
          'accepted_not_delivered',
          'processing_stuck',
          'invalid_template_drop',
          'sender_identity_error',
          'dmarc_or_auth_block',
          'high_unsubscribes_or_spam',
          'deferrals_or_throttling',
        ]),
        recipientEmail: z.email().optional(),
        fromEmail: z.email().optional(),
        templateId: z.string().optional(),
        messageId: z.string().optional(),
        activityQuery: z.string().optional(),
        activityLimit: z.number().int().min(1).max(1000).optional(),
        provider: z.string().optional(),
        sinceDate: DateSchema.optional().describe(
          'YYYY-MM-DD for aggregate stats pull',
        ),
        partnerAccountId: z
          .string()
          .optional()
          .describe('Optional /partners/accounts/{id}/state check'),
        ...ReadInputFields,
      }),
      outputSchema: TriageDeliveryOutputSchema,
    },
    async ({
      scenario,
      recipientEmail,
      fromEmail,
      templateId,
      messageId,
      activityQuery,
      activityLimit,
      provider,
      sinceDate,
      partnerAccountId,
      response_format,
    }) => {
      const findings: string[] = [];
      const actions: string[] = [];

      if (messageId) {
        try {
          const traced = await traceMessage(client, messageId);
          findings.push(
            `Message activity for ${messageId}: ${summarizeActivityMessage(traced.message)}${traced.note ? `. ${traced.note}` : ''}`,
          );
        } catch (error) {
          findings.push(
            `Message activity lookup failed.\n${formatToolError(error)}`,
          );
        }
      }

      if (activityQuery) {
        try {
          const activity = await searchActivityOrLogs(
            client,
            activityQuery,
            activityLimit ?? 10,
          );
          findings.push(
            `Email Activity search matched ${activity.messages.length} messages via ${activity.source} for query: ${activityQuery}${activity.note ? `. ${activity.note}` : ''}`,
          );
          const first = activity.messages[0];
          if (first) findings.push(summarizeActivityMessage(first));
        } catch (error) {
          findings.push(
            `Email Activity search failed.\n${formatToolError(error)}`,
          );
        }
      }

      if (recipientEmail) {
        try {
          const suppression = await client.checkSuppression(recipientEmail);
          const suppressedGroups = suppression.groupSuppressions
            .filter((group) => group.suppressed)
            .map((group) => `${group.id}:${group.name}`)
            .join(', ');
          findings.push(
            `Suppression status for ${recipientEmail}: bounced=${suppression.bounced}, blocked=${suppression.blocked}, unsubscribed=${suppression.unsubscribed}, spamReported=${suppression.spamReported}, invalidEmail=${suppression.invalidEmail}, groupUnsubscribed=${suppression.groupUnsubscribed}${suppressedGroups ? ` groups=${suppressedGroups}` : ''}`,
          );
        } catch (error) {
          findings.push(`Suppression check failed.\n${formatToolError(error)}`);
        }
      }

      if (templateId) {
        try {
          const template = await client.getTemplate(templateId);
          const active = template.versions.find(
            (version) => version.active === 1,
          );
          findings.push(
            active
              ? `Template ${templateId} active version: ${active.id} (subject: "${active.subject}")`
              : `Template ${templateId} has no active version.`,
          );
        } catch (error) {
          findings.push(
            `Template lookup failed for ${templateId}.\n${formatToolError(error)}`,
          );
        }
      }

      if (fromEmail) {
        const senderDomain = domainFromEmail(fromEmail);
        try {
          const [domains, verifiedSenders] = await Promise.all([
            client.listAuthenticatedDomains(),
            client.listVerifiedSenders({ limit: 200 }),
          ]);

          const domainAuthenticated = domains.some((domain) => {
            const root = domain.domain?.toLowerCase();
            if (!root || domain.valid === false) return false;
            return senderDomain === root || senderDomain.endsWith(`.${root}`);
          });

          const senderVerified = verifiedSenders.some(
            (sender) =>
              sender.verified === true &&
              typeof sender.from_email === 'string' &&
              normalize(sender.from_email) === normalize(fromEmail),
          );

          findings.push(
            `Sender checks for ${fromEmail}: domainAuthenticated=${domainAuthenticated}, senderVerified=${senderVerified}`,
          );
        } catch (error) {
          findings.push(
            `Sender-auth checks failed.\n${formatToolError(error)}`,
          );
        }
      }

      if (partnerAccountId) {
        try {
          const state = await client.getPartnerAccountState(partnerAccountId);
          findings.push(`Partner account state: ${state.state}`);
        } catch (error) {
          findings.push(
            `Partner account-state check failed.\n${formatToolError(error)}`,
          );
        }
      }

      if (sinceDate) {
        try {
          const stats = await client.getStats(sinceDate);
          const total = stats.reduce(
            (acc, day) => {
              const metrics = day.stats[0]?.metrics;
              if (!metrics) return acc;
              acc.requests += metrics.requests;
              acc.delivered += metrics.delivered;
              acc.bounces += metrics.bounces;
              acc.opens += metrics.opens;
              acc.clicks += metrics.clicks;
              acc.unsubscribes += metrics.unsubscribes;
              acc.spamReports += metrics.spam_reports;
              return acc;
            },
            {
              requests: 0,
              delivered: 0,
              bounces: 0,
              opens: 0,
              clicks: 0,
              unsubscribes: 0,
              spamReports: 0,
            },
          );
          findings.push(
            `Stats since ${sinceDate}: requests=${total.requests}, delivered=${total.delivered} (${summarizeRates(total.requests, total.delivered)}), bounces=${total.bounces}, opens=${total.opens}, clicks=${total.clicks}, unsubscribes=${total.unsubscribes}, spam_reports=${total.spamReports}`,
          );
        } catch (error) {
          findings.push(`Stats lookup failed.\n${formatToolError(error)}`);
        }
      }

      switch (scenario) {
        case 'accepted_not_delivered':
          actions.push(
            'Treat 202 as queue acceptance, not inbox delivery confirmation.',
            'Check template validity/active version and render inputs.',
            'Check account state/billing and suppressions for affected recipients.',
            'Use Event Webhook or Activity Feed for final event outcome correlation.',
          );
          break;
        case 'processing_stuck':
          actions.push(
            'Check account billing/frozen state first.',
            'Re-trigger sends from integration after account reactivation; old processing items may never complete.',
            'Track delivery outcomes via webhook, not request-time status only.',
          );
          break;
        case 'invalid_template_drop':
          actions.push(
            'Verify template ID exists and active version is set.',
            'Ensure payload data keys match template handlebars expectations.',
            'Re-send only after template activation/repair.',
          );
          break;
        case 'sender_identity_error':
          actions.push(
            'Use a From domain that is authenticated in SendGrid.',
            'Do not rely on free mailbox From domains for API traffic.',
            'Keep Reply-To for user-facing mailbox while From stays authenticated.',
          );
          break;
        case 'dmarc_or_auth_block':
          actions.push(
            'Align From domain with authenticated domain/SPF+DKIM configuration.',
            'Avoid protected mailbox-provider From domains (gmail/yahoo/aol) in API sends.',
            'Use dedicated sending domain/subdomain and verify DMARC alignment policy.',
          );
          break;
        case 'high_unsubscribes_or_spam':
          actions.push(
            'Inspect event stream for non-human opens/clicks triggering accidental unsubscribes.',
            'Use group unsubscribes/ASM to force deliberate unsubscribe flow.',
            'Reduce sends to low-engagement users and apply sunsetting policy.',
          );
          break;
        case 'deferrals_or_throttling':
          actions.push(
            'Throttle per provider domain and spread sends over time.',
            'Use scheduled sends with batching instead of burst sends.',
            'For Yahoo-related domains, use conservative hourly pacing and monitor deferrals.',
          );
          if (provider && normalize(provider).includes('yahoo')) {
            actions.push(
              'Yahoo-specific: keep hourly sends per IP low and avoid peak-time bursts.',
            );
          }
          break;
      }

      return jsonReadResult(
        { scenario, findings, actions },
        [
          `Scenario: ${scenario}`,
          '',
          'Findings:',
          ...(findings.length > 0
            ? findings.map((finding) => `- ${finding}`)
            : ['- No runtime findings were gathered.']),
          '',
          'Recommended actions:',
          ...actions.map((action) => `- ${action}`),
        ].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'analyze_engagement_anomalies',
    {
      description:
        'Analyze Event Webhook events for non-human engagement patterns, machine opens, and unique-open approximation.',
      inputSchema: z.object({
        events: z
          .array(
            z
              .object({
                event: z.string(),
                email: z.string().optional(),
                timestamp: z.number().int().optional(),
                ip: z.string().optional(),
                useragent: z.string().optional(),
                sg_machine_open: z.boolean().optional(),
                sg_message_id: z.string().optional(),
              })
              .passthrough(),
          )
          .min(1),
        nearDeliveryWindowSec: z
          .number()
          .int()
          .optional()
          .describe(
            'Delta window to mark suspicious immediate clicks (default 5s)',
          ),
        ...ReadInputFields,
      }),
      outputSchema: AnalyzeEngagementOutputSchema,
    },
    async ({ events, nearDeliveryWindowSec, response_format }) => {
      const webhookEvents = events as EngagementEvent[];
      const clickEvents = webhookEvents.filter(
        (event) => event.event === 'click',
      );
      const openEvents = webhookEvents.filter(
        (event) => event.event === 'open',
      );
      const deliveredEvents = webhookEvents.filter(
        (event) => event.event === 'delivered',
      );

      const machineOpens = openEvents.filter(
        (event) => event.sg_machine_open === true,
      ).length;
      const gmailPrefetchOpens = openEvents.filter((event) => {
        const ua = normalize(event.useragent ?? '');
        return ua.includes('googleimageproxy') || ua.includes('ggpht.com');
      }).length;

      const openOrClickIps = webhookEvents
        .filter((event) => event.event === 'open' || event.event === 'click')
        .map((event) => event.ip ?? '')
        .filter(Boolean);
      const topIp = findTopCount(openOrClickIps);
      const topIpShare =
        topIp && openOrClickIps.length > 0
          ? (topIp.count / openOrClickIps.length) * 100
          : 0;

      const openOrClickUa = webhookEvents
        .filter((event) => event.event === 'open' || event.event === 'click')
        .map((event) => normalize(event.useragent ?? ''))
        .filter(Boolean);
      const topUa = findTopCount(openOrClickUa);

      const deliveredAtByKey = new Map<string, number>();
      for (const event of deliveredEvents) {
        const key = event.sg_message_id ?? event.email ?? '';
        if (!key || typeof event.timestamp !== 'number') continue;
        const existing = deliveredAtByKey.get(key);
        if (existing === undefined || event.timestamp < existing) {
          deliveredAtByKey.set(key, event.timestamp);
        }
      }

      const suspiciousImmediateClicks = clickEvents.filter((event) => {
        const key = event.sg_message_id ?? event.email ?? '';
        const deliveredAt = deliveredAtByKey.get(key);
        if (
          !key ||
          deliveredAt === undefined ||
          event.timestamp === undefined
        ) {
          return false;
        }
        return (
          Math.abs(event.timestamp - deliveredAt) <=
          (nearDeliveryWindowSec ?? 5)
        );
      }).length;

      const uniqueOpenApproxByKey = new Set<string>();
      for (const event of openEvents) {
        if (event.sg_machine_open === true) continue;
        const key = event.sg_message_id ?? event.email;
        if (!key) continue;
        uniqueOpenApproxByKey.add(key);
      }

      const findings: string[] = [];
      if (machineOpens > 0) {
        findings.push(
          `Machine opens detected (sg_machine_open=true): ${machineOpens}.`,
        );
      }
      if (gmailPrefetchOpens > 0) {
        findings.push(`Likely Gmail prefetch opens: ${gmailPrefetchOpens}.`);
      }
      if (topIp && topIpShare >= 60 && openOrClickIps.length >= 10) {
        findings.push(
          `High single-IP concentration: ${topIp.value} accounts for ${topIpShare.toFixed(1)}% of open/click events.`,
        );
      }
      if (topUa && topUa.count >= 10) {
        findings.push(
          `Repeated user-agent pattern detected (${topUa.count} events): ${topUa.value}`,
        );
      }
      if (suspiciousImmediateClicks > 0) {
        findings.push(
          `Clicks within ${nearDeliveryWindowSec ?? 5}s of delivery: ${suspiciousImmediateClicks}.`,
        );
      }

      const suggestions = [
        'Exclude sg_machine_open=true from user-open KPIs.',
        'De-duplicate opens by message ID for unique-open metrics.',
        'Down-rank click/open bursts with same IP + same user-agent near delivery time.',
      ];

      const structured = {
        totals: {
          events: webhookEvents.length,
          opens: openEvents.length,
          clicks: clickEvents.length,
          delivered: deliveredEvents.length,
          uniqueOpenApprox: uniqueOpenApproxByKey.size,
        },
        findings,
        suggestions,
      };

      return jsonReadResult(
        structured,
        [
          'Engagement analysis:',
          `- Total events: ${webhookEvents.length}`,
          `- Opens: ${openEvents.length}`,
          `- Clicks: ${clickEvents.length}`,
          `- Delivered: ${deliveredEvents.length}`,
          `- Unique-open approximation (first non-machine open per message/email): ${uniqueOpenApproxByKey.size}`,
          '',
          'Anomaly findings:',
          ...(findings.length > 0
            ? findings.map((finding) => `- ${finding}`)
            : ['- No strong anomaly pattern detected.']),
          '',
          'Suggested handling:',
          ...suggestions.map((item) => `- ${item}`),
        ].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'list_asm_groups',
    {
      description:
        'List ASM unsubscribe groups (GET /v3/asm/groups). Use the id as asm.groupId when sending. This is not a marketing contact list.',
      inputSchema: z.object({ ...ReadInputFields }),
      outputSchema: AsmGroupListOutputSchema,
    },
    async ({ response_format }) => {
      const groups = await client.listAsmGroups();
      return jsonReadResult(
        { count: groups.length, groups },
        groups.length === 0
          ? 'No ASM unsubscribe groups.'
          : groups
              .map(
                (group) =>
                  `- ${group.id} ${group.name} default=${String(group.is_default ?? false)} unsubscribes=${group.unsubscribes ?? 'n/a'}`,
              )
              .join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'create_asm_group',
    {
      description:
        'Create an ASM unsubscribe group (POST /v3/asm/groups) for transactional mail. Does not create a marketing list.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        name: z.string().min(1).max(100),
        description: z.string().min(1).max(255),
        isDefault: z.boolean().optional(),
      }),
      outputSchema: AsmGroupSchema,
    },
    async ({ name, description, isDefault }) => {
      const group = await client.createAsmGroup({
        name,
        description,
        is_default: isDefault,
      });
      return jsonReadResult(
        group,
        `Created ASM group ${group.id} ${group.name}.`,
      );
    },
  );

  server.registerTool(
    'list_suppressions',
    {
      description:
        'List SendGrid suppressions by type (bounces, blocks, unsubscribes, spam reports, invalid emails, global unsubscribes).',
      inputSchema: z.object({
        type: z.enum([
          'bounces',
          'blocks',
          'unsubscribes',
          'spam_reports',
          'invalid_emails',
          'global_unsubscribes',
        ]),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
        email: z.email().optional(),
        response_format: ResponseFormatSchema.optional(),
      }),
      outputSchema: ListSuppressionsOutputSchema,
    },
    async ({ type, limit, offset, startTime, endTime, email, response_format }) => {
      const pageLimit = limit ?? 50;
      const pageOffset = offset ?? 0;
      const entries = await client.listSuppressions(type, {
        limit: pageLimit,
        offset: pageOffset,
        startTime,
        endTime,
        email,
      });

      const rows = entries.map((entry) => {
        return `- email=${entry.email} | created=${entry.created} | reason=${entry.reason ?? 'n/a'} | status=${entry.status ?? 'n/a'}`;
      });

      const pagination = buildPaginationMeta({
        totalCount: pageOffset + entries.length,
        count: entries.length,
        offset: pageOffset,
      });

      return jsonReadResult(
        {
          ...pagination,
          has_more: entries.length >= pageLimit,
          next_offset:
            entries.length >= pageLimit ? pageOffset + entries.length : null,
          type,
          entries,
        },
        rows.length === 0
          ? `No entries in ${type}.`
          : [`Type: ${type}`, `Entries: ${rows.length}`, '', ...rows].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'check_suppression',
    {
      description:
        'Check bounce, block, global unsubscribe, spam report, invalid email, and ASM group suppressions (GET /v3/asm/suppressions/{email}) for one recipient.',
      inputSchema: z.object({
        email: z.email().describe('Email address to check'),
        ...ReadInputFields,
      }),
      outputSchema: z.object({
        email: z.email(),
        bounced: z.boolean(),
        blocked: z.boolean(),
        unsubscribed: z.boolean(),
        spamReported: z.boolean(),
        invalidEmail: z.boolean(),
        groupUnsubscribed: z.boolean(),
        groupSuppressions: z.array(AsmGroupSuppressionSchema),
        groupLookupError: z.string().optional(),
      }),
    },
    async ({ email, response_format }) => {
      const result = await client.checkSuppression(email);

      const flags = [
        result.bounced && 'BOUNCED',
        result.blocked && 'BLOCKED',
        result.unsubscribed && 'GLOBAL UNSUBSCRIBE',
        result.spamReported && 'SPAM REPORTED',
        result.invalidEmail && 'INVALID EMAIL',
        result.groupUnsubscribed && 'GROUP UNSUBSCRIBE',
      ].filter(Boolean);

      const status =
        flags.length === 0 ? 'Clean - not suppressed' : flags.join(' | ');

      const lines = [`Email: ${email}`, `Status: ${status}`, ``];

      const details = result.details as Record<string, unknown[]>;
      for (const [key, entries] of Object.entries(details)) {
        if (Array.isArray(entries) && entries.length > 0) {
          lines.push(`${key}: ${JSON.stringify(entries, null, 2)}`);
        }
      }

      if (result.groupLookupError) {
        lines.push(`ASM group lookup failed: ${result.groupLookupError}`);
      }
      const suppressedGroups = result.groupSuppressions.filter(
        (group) => group.suppressed,
      );
      if (suppressedGroups.length > 0) {
        lines.push(
          `ASM groups: ${suppressedGroups.map((group) => `${group.id} ${group.name}`).join(', ')}`,
        );
      }

      return jsonReadResult(
        {
          email,
          bounced: result.bounced,
          blocked: result.blocked,
          unsubscribed: result.unsubscribed,
          spamReported: result.spamReported,
          invalidEmail: result.invalidEmail,
          groupUnsubscribed: result.groupUnsubscribed,
          groupSuppressions: result.groupSuppressions.map((group) => ({
            id: group.id,
            name: group.name || `group ${group.id}`,
            suppressed: group.suppressed,
          })),
          ...(result.groupLookupError
            ? { groupLookupError: result.groupLookupError }
            : {}),
        },
        lines.join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'get_email_stats',
    {
      description:
        'Get email statistics. dimension=global is the account daily rollup. category requires categories. mailbox_provider, geo, browser, device, and client are the other SendGrid stats cuts. Browser, device, and client stats retain about 7 days.',
      inputSchema: z.object({
        startDate: DateSchema.describe('Start date YYYY-MM-DD'),
        endDate: DateSchema.optional().describe(
          'End date YYYY-MM-DD (defaults to today)',
        ),
        dimension: StatsDimensionSchema.optional().describe(
          'Default global. category requires categories. browser, device, and client only retain about 7 days.',
        ),
        aggregatedBy: z.enum(['day', 'week', 'month']).optional(),
        categories: z.array(z.string().min(1)).max(25).optional(),
        mailboxProviders: z.array(z.string().min(1)).max(10).optional(),
        country: z.string().length(2).optional().describe('ISO country code for dimension=geo'),
        browsers: z.array(z.string().min(1)).max(10).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        ...ReadInputFields,
      }),
      outputSchema: EmailStatsOutputSchema,
    },
    async ({
      startDate,
      endDate,
      dimension,
      aggregatedBy,
      categories,
      mailboxProviders,
      country,
      browsers,
      limit,
      response_format,
    }) => {
      const selected = dimension ?? 'global';
      const payload = await client.getStats({
        startDate,
        endDate,
        dimension: selected,
        aggregatedBy,
        categories,
        mailboxProviders,
        country,
        browsers,
        limit,
      });
      const { totals, lines } = collectStatTotals(payload);
      const note = SHORT_STATS_WINDOW.has(selected)
        ? 'Browser, device, and client statistics retain about 7 days.'
        : undefined;
      const series = selected === 'global' ? undefined : asStatsSeries(payload);

      return jsonReadResult(
        {
          startDate,
          endDate: endDate ?? null,
          dimension: selected,
          aggregatedBy: aggregatedBy ?? 'day',
          totals,
          ...(note ? { note } : {}),
          ...(series ? { series } : {}),
        },
        [
          `Stats (${selected}): ${startDate} → ${endDate ?? 'today'}`,
          ...(note ? [note] : []),
          `Total: ${totals.requests} requests, ${totals.delivered} delivered, ${totals.bounces} bounces, ${totals.opens} opens`,
          '',
          ...(lines.length > 0 ? lines : ['No stats for the given range.']),
        ].join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'list_categories',
    {
      description:
        'List category names (GET /v3/categories) so get_email_stats dimension=category can be given a real categories array.',
      inputSchema: z.object({
        category: z.string().min(1).optional().describe('Filter by category name prefix or exact name, per SendGrid'),
        ...ListPagingInputFields,
      }),
      outputSchema: CategoryListOutputSchema,
    },
    async ({ category, limit, offset, response_format }) => {
      const categories = await client.listCategories({
        category,
        limit: limit ?? 50,
        offset: offset ?? 0,
      });
      return jsonReadResult(
        { count: categories.length, categories },
        categories.length === 0
          ? 'No categories.'
          : categories.map((name) => `- ${name}`).join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'search_email_logs',
    {
      description:
        'Search Email Logs (POST /v3/logs). Use when Email Activity is unavailable, especially for EU regional subusers. Query fields: sg_message_id =, subject =, to_email =, status IN, reason =, categories IN, sg_message_id_created_at comparisons. Combine with AND. No nesting. Parent accounts pass exactly one subuser.',
      inputSchema: z.object({
        query: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        subusers: z.array(z.string().min(1)).max(1).optional(),
        ...ReadInputFields,
      }),
      outputSchema: EmailLogsOutputSchema,
    },
    async ({ query, limit, subusers, response_format }) => {
      const result = await client.searchEmailLogs({ query, limit, subusers });
      const messages = result.messages ?? [];
      return jsonReadResult(
        { count: messages.length, messages },
        messages.length === 0
          ? 'No Email Logs rows matched.'
          : messages
              .map(
                (message) =>
                  `- sg_message_id=${message.sg_message_id ?? 'n/a'} status=${message.status ?? 'n/a'} to=${message.to_email ?? 'n/a'} reason=${message.reason ?? 'n/a'}`,
              )
              .join('\n'),
        response_format,
      );
    },
  );

  server.registerTool(
    'delete_suppression',
    {
      description:
        'Remove one recipient from a suppression list: bounce, block, spam_report, invalid_email, global unsubscribe, or one ASM group. Does not delete the group itself.',
      inputSchema: z
        .object({
          confirmToken: ConfirmTokenSchema,
          email: z.email(),
          type: z.enum([
            'bounce',
            'block',
            'spam_report',
            'invalid_email',
            'global',
            'group',
          ]),
          groupId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Required when type is group'),
        })
        .superRefine((value, ctx) => {
          if (value.type === 'group' && value.groupId === undefined) {
            ctx.addIssue({
              code: 'custom',
              message: 'groupId is required when type is group',
              path: ['groupId'],
            });
          }
        }),
      outputSchema: DeleteSuppressionOutputSchema,
    },
    async ({ email, type, groupId }) => {
      await client.deleteSuppression({ type, email, groupId });
      return jsonReadResult(
        {
          deleted: true,
          type,
          email,
          groupId: groupId ?? null,
        },
        `Deleted ${type} suppression for ${email}${groupId !== undefined ? ` in group ${groupId}` : ''}.`,
      );
    },
  );
}
