import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isSendGridApiError, type SendGridClient } from '../client';
import {
  clearStoredWebhookEvents,
  getStoredWebhookEvents,
  getWebhookReceiverStatus,
} from '../webhook_receiver';

type EngagementEvent = {
  event: string;
  email?: string;
  timestamp?: number;
  ip?: string;
  useragent?: string;
  sg_machine_open?: boolean;
  sg_message_id?: string;
};

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

function classifyError(statusCode: number | undefined, text: string) {
  const details: {
    category: string;
    probableCauses: string[];
    actions: string[];
  } = {
    category: 'unknown',
    probableCauses: ['Insufficient context to classify exactly.'],
    actions: ['Check full API error body and endpoint payload.'],
  };

  if (
    text.includes('from address does not match a verified sender identity') ||
    text.includes('verified sender identity')
  ) {
    return {
      category: 'sender_identity',
      probableCauses: [
        'From address/domain is not verified for API sending.',
        'Domain authentication not configured for sender domain.',
      ],
      actions: [
        'Authenticate sender domain and use matching From domain.',
        'Run sender preflight checks before retrying.',
      ],
    };
  }

  if (
    text.includes('invalid template') ||
    text.includes('template') ||
    text.includes('dropped')
  ) {
    return {
      category: 'template_validation',
      probableCauses: [
        'Template ID is invalid or inaccessible.',
        'Template has no active version.',
        'Template render data does not match expected handlebars variables.',
      ],
      actions: [
        'Verify template ID exists and has active version.',
        'Validate dynamic template data against template variables.',
      ],
    };
  }

  if (text.includes('attachment content must be base64')) {
    return {
      category: 'attachment_encoding',
      probableCauses: ['Attachment payload is not base64-encoded correctly.'],
      actions: [
        'Base64-encode attachment content before send.',
        'Validate attachment payload in preflight.',
      ],
    };
  }

  if (statusCode === 429 || text.includes('rate limit')) {
    return {
      category: 'rate_limit',
      probableCauses: ['Endpoint rate limit exceeded.'],
      actions: [
        'Back off and retry after reset.',
        'Queue requests and apply per-endpoint pacing.',
      ],
    };
  }

  if (statusCode === 413 || text.includes('payload too large')) {
    return {
      category: 'payload_too_large',
      probableCauses: [
        'Email payload or attachment set exceeds API/provider limits.',
      ],
      actions: [
        'Reduce attachment sizes and payload footprint.',
        'Move large files to hosted links instead of attachments.',
      ],
    };
  }

  if (statusCode === 401) {
    return {
      category: 'auth_or_account_state',
      probableCauses: [
        'Invalid/revoked API key or missing scopes.',
        'Account in disabled/frozen/credit-exceeded state.',
      ],
      actions: [
        'Verify API key validity and scopes.',
        'Check account/billing state before retrying sends.',
      ],
    };
  }

  if (statusCode === 403) {
    return {
      category: 'permissions_or_policy',
      probableCauses: [
        'API key lacks required permissions.',
        'Endpoint forbidden for this account/plan state.',
      ],
      actions: [
        'Use key with required scopes.',
        'Validate account feature availability for the endpoint.',
      ],
    };
  }

  if (statusCode === 400) {
    return {
      category: 'payload_validation',
      probableCauses: [
        'Malformed JSON or invalid request schema.',
        'Duplicate recipients across to/cc/bcc in a personalization block.',
        'Missing required fields (subject/content/from/personalizations).',
      ],
      actions: [
        'Validate payload schema and required fields.',
        'Ensure recipient uniqueness per personalization block.',
      ],
    };
  }

  return details;
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
  server.registerTool(
    'search_message_activity',
    {
      description:
        'Search SendGrid Email Activity API messages using query syntax (from_email, to_email, status, etc).',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'SendGrid Email Activity query, e.g. from_email="ops@acme.com" AND to_email="user@acme.com"',
          ),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
    },
    async ({ query, limit }) => {
      try {
        const response = await client.filterMessages(query, limit ?? 25);
        const messages = response.messages ?? [];
        const rows = messages.map((message) => {
          return [
            `- msg_id=${message.msg_id ?? 'n/a'}`,
            `status=${String(message.status ?? 'n/a')}`,
            `from=${String(message.from_email ?? 'n/a')}`,
            `to=${String(message.to_email ?? 'n/a')}`,
            `subject=${String(message.subject ?? 'n/a')}`,
            `last_event_time=${String(message.last_event_time ?? 'n/a')}`,
          ].join(' | ');
        });

        return {
          content: [
            {
              type: 'text',
              text:
                rows.length === 0
                  ? 'No messages matched query.'
                  : [
                      `Matched messages: ${rows.length}`,
                      '',
                      ...rows,
                    ].join('\n'),
            },
          ],
        };
      } catch (error) {
        if (isSendGridApiError(error)) {
          const addonHint =
            error.status === 403 || error.status === 404
              ? '\nHint: Email Activity API may require the Email Activity add-on.'
              : '';
          throw new Error(
            `Failed to query Email Activity API (${error.status}).${addonHint}\n${error.errors
              .map((entry) => `- ${entry.message}`)
              .join('\n')}`,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'get_message_activity',
    {
      description: 'Get SendGrid Email Activity details for one message by msg_id.',
      inputSchema: z.object({
        msgId: z.string().min(1),
      }),
    },
    async ({ msgId }) => {
      try {
        const message = await client.getMessageById(msgId);
        return {
          content: [{ type: 'text', text: JSON.stringify(message, null, 2) }],
        };
      } catch (error) {
        if (isSendGridApiError(error)) {
          const addonHint =
            error.status === 403 || error.status === 404
              ? '\nHint: Email Activity API access may be unavailable without add-on.'
              : '';
          throw new Error(
            `Failed to load message activity (${error.status}).${addonHint}\n${error.errors
              .map((entry) => `- ${entry.message}`)
              .join('\n')}`,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'list_event_webhooks',
    {
      description: 'List all Event Webhook configurations directly from SendGrid.',
      inputSchema: z.object({
        includeAccountStatusChange: z.boolean().optional(),
      }),
    },
    async ({ includeAccountStatusChange }) => {
      const response = await client.getAllEventWebhooks(
        includeAccountStatusChange ?? false,
      );
      const webhooks = response.webhooks ?? [];
      const rows = webhooks.map((webhook) => {
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

      return {
        content: [
          {
            type: 'text',
            text:
              rows.length === 0
                ? 'No event webhooks found.'
                : [
                    `Max allowed webhooks: ${response.max_allowed ?? 'n/a'}`,
                    `Configured webhooks: ${rows.length}`,
                    '',
                    ...rows,
                  ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_event_webhook',
    {
      description: 'Get one Event Webhook config by ID from SendGrid.',
      inputSchema: z.object({
        id: z.string().min(1),
        includeAccountStatusChange: z.boolean().optional(),
      }),
    },
    async ({ id, includeAccountStatusChange }) => {
      const webhook = await client.getEventWebhook(
        id,
        includeAccountStatusChange ?? false,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(webhook, null, 2) }],
      };
    },
  );

  server.registerTool(
    'update_event_webhook',
    {
      description:
        'Update Event Webhook settings in SendGrid (URL, enabled flag, and event toggles).',
      inputSchema: z.object({
        id: z.string().min(1),
        includeAccountStatusChange: z.boolean().optional(),
        enabled: z.boolean().optional(),
        url: z.string().url().optional(),
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
          oauth_client_id: oauthClientId,
          oauth_client_secret: oauthClientSecret,
          oauth_token_url: oauthTokenUrl,
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

  server.registerTool(
    'get_webhook_receiver_status',
    {
      description:
        'Show local webhook receiver status for incoming SendGrid Event Webhook posts.',
      inputSchema: {},
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(getWebhookReceiverStatus(), null, 2),
          },
        ],
      };
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
        email: z.string().email().optional(),
        messageId: z.string().optional(),
        onlyVerified: z.boolean().optional(),
      }),
    },
    async ({ limit, eventType, email, messageId, onlyVerified }) => {
      const events = getStoredWebhookEvents({
        limit,
        eventType,
        email,
        messageId,
        onlyVerified,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              events.length === 0
                ? 'No matching webhook events captured.'
                : JSON.stringify(events, null, 2),
          },
        ],
      };
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
      inputSchema: z.object({
        statusCode: z.number().int().optional(),
        errorMessage: z.string().optional(),
        rawBody: z.string().optional(),
      }),
    },
    async ({ statusCode, errorMessage, rawBody }) => {
      const text = normalize(`${errorMessage ?? ''}\n${rawBody ?? ''}`);
      const classified = classifyError(statusCode, text);

      return {
        content: [
          {
            type: 'text',
            text: [
              `Category: ${classified.category}`,
              `Status code: ${statusCode ?? 'unknown'}`,
              '',
              'Probable causes:',
              ...classified.probableCauses.map((cause) => `- ${cause}`),
              '',
              'Recommended actions:',
              ...classified.actions.map((action) => `- ${action}`),
            ].join('\n'),
          },
        ],
      };
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
        recipientEmail: z.string().email().optional(),
        fromEmail: z.string().email().optional(),
        templateId: z.string().optional(),
        messageId: z.string().optional(),
        activityQuery: z.string().optional(),
        activityLimit: z.number().int().min(1).max(1000).optional(),
        provider: z.string().optional(),
        sinceDate: z
          .string()
          .optional()
          .describe('YYYY-MM-DD for aggregate stats pull'),
        partnerAccountId: z
          .string()
          .optional()
          .describe('Optional /partners/accounts/{id}/state check'),
      }),
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
    }) => {
      const findings: string[] = [];
      const actions: string[] = [];

      if (messageId) {
        try {
          const message = await client.getMessageById(messageId);
          findings.push(
            `Message activity for ${messageId}: status=${String(message.status ?? 'n/a')}, from=${String(message.from_email ?? 'n/a')}, to=${String(message.to_email ?? 'n/a')}, last_event_time=${String(message.last_event_time ?? 'n/a')}`,
          );
        } catch (error) {
          if (isSendGridApiError(error)) {
            findings.push(
              `Message activity lookup failed (${error.status}): ${error.errors.map((entry) => entry.message).join('; ')}`,
            );
          } else {
            findings.push(`Message activity lookup failed: ${String(error)}`);
          }
        }
      }

      if (activityQuery) {
        try {
          const activity = await client.filterMessages(
            activityQuery,
            activityLimit ?? 10,
          );
          findings.push(
            `Email Activity search matched ${activity.messages?.length ?? 0} messages for query: ${activityQuery}`,
          );
        } catch (error) {
          if (isSendGridApiError(error)) {
            findings.push(
              `Email Activity search failed (${error.status}): ${error.errors.map((entry) => entry.message).join('; ')}`,
            );
          } else {
            findings.push(`Email Activity search failed: ${String(error)}`);
          }
        }
      }

      if (recipientEmail) {
        try {
          const suppression = await client.checkSuppression(recipientEmail);
          findings.push(
            `Suppression status for ${recipientEmail}: bounced=${suppression.bounced}, blocked=${suppression.blocked}, unsubscribed=${suppression.unsubscribed}, spamReported=${suppression.spamReported}`,
          );
        } catch (error) {
          findings.push(`Suppression check failed: ${String(error)}`);
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
            `Template lookup failed for ${templateId}: ${String(error)}`,
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
          findings.push(`Sender-auth checks failed: ${String(error)}`);
        }
      }

      if (partnerAccountId) {
        try {
          const state = await client.getPartnerAccountState(partnerAccountId);
          findings.push(`Partner account state: ${state.state}`);
        } catch (error) {
          findings.push(`Partner account-state check failed: ${String(error)}`);
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
          findings.push(`Stats lookup failed: ${String(error)}`);
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

      return {
        content: [
          {
            type: 'text',
            text: [
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
          },
        ],
      };
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
      }),
    },
    async ({ events, nearDeliveryWindowSec }) => {
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

      return {
        content: [
          {
            type: 'text',
            text: [
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
              '- Exclude sg_machine_open=true from user-open KPIs.',
              '- De-duplicate opens by message ID for unique-open metrics.',
              '- Down-rank click/open bursts with same IP + same user-agent near delivery time.',
            ].join('\n'),
          },
        ],
      };
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
        email: z.string().email().optional(),
      }),
    },
    async ({ type, limit, offset, startTime, endTime, email }) => {
      const entries = await client.listSuppressions(type, {
        limit: limit ?? 50,
        offset,
        startTime,
        endTime,
        email,
      });

      const rows = entries.map((entry) => {
        return `- email=${entry.email} | created=${entry.created} | reason=${entry.reason ?? 'n/a'} | status=${entry.status ?? 'n/a'}`;
      });

      return {
        content: [
          {
            type: 'text',
            text:
              rows.length === 0
                ? `No entries in ${type}.`
                : [`Type: ${type}`, `Entries: ${rows.length}`, '', ...rows].join(
                    '\n',
                  ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'check_suppression',
    {
      description:
        'Check if an email address is suppressed (bounced / blocked / unsubscribed / spam reported)',
      inputSchema: z.object({
        email: z.string().email().describe('Email address to check'),
      }),
    },
    async ({ email }) => {
      const result = await client.checkSuppression(email);

      const flags = [
        result.bounced && '🔴 BOUNCED',
        result.blocked && '🔴 BLOCKED',
        result.unsubscribed && '🟡 UNSUBSCRIBED',
        result.spamReported && '🔴 SPAM REPORTED',
      ].filter(Boolean);

      const status =
        flags.length === 0 ? '✅ Clean — not suppressed' : flags.join('  ');

      const lines = [`Email: ${email}`, `Status: ${status}`, ``];

      const details = result.details as Record<string, unknown[]>;
      for (const [key, entries] of Object.entries(details)) {
        if (Array.isArray(entries) && entries.length > 0) {
          lines.push(`${key}: ${JSON.stringify(entries, null, 2)}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'get_email_stats',
    {
      description: 'Get global email delivery statistics for a date range',
      inputSchema: z.object({
        startDate: z.string().describe('Start date YYYY-MM-DD'),
        endDate: z
          .string()
          .optional()
          .describe('End date YYYY-MM-DD (defaults to today)'),
      }),
    },
    async ({ startDate, endDate }) => {
      const stats = await client.getStats(startDate, endDate);

      if (stats.length === 0) {
        return {
          content: [{ type: 'text', text: 'No stats for the given range.' }],
        };
      }

      const rows = stats.map((day) => {
        const m = day.stats[0]?.metrics;
        if (!m) return `${day.date}: no data`;
        const rate =
          m.requests > 0 ? ((m.delivered / m.requests) * 100).toFixed(1) : '—';
        return [
          `${day.date}`,
          `  requests=${m.requests}  delivered=${m.delivered} (${rate}%)`,
          `  bounces=${m.bounces}  spam=${m.spam_reports}  unsubs=${m.unsubscribes}`,
          `  opens=${m.opens}  clicks=${m.clicks}`,
        ].join('\n');
      });

      const total = stats.reduce(
        (acc, day) => {
          const m = day.stats[0]?.metrics;
          if (!m) return acc;
          acc.requests += m.requests;
          acc.delivered += m.delivered;
          acc.bounces += m.bounces;
          acc.opens += m.opens;
          return acc;
        },
        { requests: 0, delivered: 0, bounces: 0, opens: 0 },
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Stats: ${startDate} → ${endDate ?? 'today'}`,
              `Total: ${total.requests} requests, ${total.delivered} delivered, ${total.bounces} bounces, ${total.opens} opens`,
              ``,
              ...rows,
            ].join('\n'),
          },
        ],
      };
    },
  );
}
