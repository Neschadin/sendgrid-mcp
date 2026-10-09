import { z } from 'zod';
import type { ResponseFormat } from './tool_utils';

export function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function buildPaginationMeta(params: {
  totalCount: number;
  count: number;
  offset?: number;
}) {
  const offset = params.offset ?? 0;
  const hasMore = offset + params.count < params.totalCount;
  return {
    total_count: params.totalCount,
    count: params.count,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + params.count : null,
  };
}

export function paginateArray<T>(items: T[], limit = 50, offset = 0) {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const safeOffset = Math.max(0, offset);
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: page,
    pagination: buildPaginationMeta({
      totalCount: items.length,
      count: page.length,
      offset: safeOffset,
    }),
  };
}

export function formatReadResponse<T extends Record<string, unknown> | object>(
  structuredContent: T,
  markdownText: string,
  responseFormat: ResponseFormat = 'markdown',
) {
  return {
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text:
          responseFormat === 'json'
            ? jsonText(structuredContent)
            : markdownText,
      },
    ],
  };
}

export function jsonReadResult<T extends Record<string, unknown> | object>(
  structuredContent: T,
  markdownText?: string,
  responseFormat: ResponseFormat = 'markdown',
) {
  return formatReadResponse(
    structuredContent,
    markdownText ?? jsonText(structuredContent),
    responseFormat,
  );
}

export const PaginationMetaSchema = z.object({
  total_count: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
});

export const PassthroughRecordSchema = z.record(z.string(), z.unknown());

export const PreflightOutputSchema = z.object({
  ok: z.boolean(),
  blockers: z.array(
    z.object({
      severity: z.literal('blocker'),
      code: z.string(),
      message: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      severity: z.literal('warning'),
      code: z.string(),
      message: z.string(),
    }),
  ),
  info: z.array(
    z.object({
      severity: z.literal('info'),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export type PreflightOutput = z.infer<typeof PreflightOutputSchema>;

export const SendWithPreflightOutputSchema = z.object({
  sent: z.boolean(),
  report: PreflightOutputSchema,
  statusCode: z.number().nullable(),
  messageId: z.string().nullable(),
});

export const SendTestEmailOutputSchema = z.object({
  sent: z.boolean(),
  sandbox: z.boolean(),
  report: PreflightOutputSchema,
  statusCode: z.number().nullable(),
  messageId: z.string().nullable(),
});

export const BatchIdOutputSchema = z.object({
  batchId: z.string(),
});

export const ClassifyErrorOutputSchema = z.object({
  category: z.string(),
  statusCode: z.number().nullable(),
  probableCauses: z.array(z.string()),
  actions: z.array(z.string()),
});

export const TriageDeliveryOutputSchema = z.object({
  scenario: z.string(),
  findings: z.array(z.string()),
  actions: z.array(z.string()),
});

export const AnalyzeEngagementOutputSchema = z.object({
  totals: z.object({
    events: z.number().int().nonnegative(),
    opens: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    uniqueOpenApprox: z.number().int().nonnegative(),
  }),
  findings: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export const SyncTemplateIdsOutputSchema = z.object({
  filePath: z.string(),
  okCount: z.number().int().nonnegative(),
  placeholderCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  rows: z.array(z.string()),
  unreferencedTemplateIds: z.array(z.string()),
});

export const UserAccountOutputSchema = PassthroughRecordSchema;
export const UserProfileOutputSchema = PassthroughRecordSchema;
export const UserCreditsOutputSchema = PassthroughRecordSchema;
export const SettingDetailOutputSchema = PassthroughRecordSchema;

export const VerifiedSenderSchema = z
  .object({
    id: z.number(),
    nickname: z.string().optional(),
    from_email: z.string().optional(),
    from_name: z.string().optional(),
    reply_to: z.string().optional(),
    verified: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .passthrough();

export const VerifiedSendersListOutputSchema = PaginationMetaSchema.extend({
  senders: z.array(VerifiedSenderSchema),
});

export const AuthenticatedDomainSchema = z
  .object({
    id: z.number(),
    subdomain: z.string(),
    domain: z.string(),
    default: z.boolean().optional(),
    valid: z.boolean().optional(),
    legacy: z.boolean().optional(),
    custom_spf: z.boolean().optional(),
    automatic_security: z.boolean().optional(),
  })
  .passthrough();

export const AuthenticatedDomainsListOutputSchema = PaginationMetaSchema.extend({
  domains: z.array(AuthenticatedDomainSchema),
});

export const BrandedLinkSchema = z
  .object({
    id: z.number(),
    domain: z.string(),
    subdomain: z.string(),
    default: z.boolean().optional(),
    valid: z.boolean().optional(),
    legacy: z.boolean().optional(),
  })
  .passthrough();

export const BrandedLinksListOutputSchema = PaginationMetaSchema.extend({
  links: z.array(BrandedLinkSchema),
});

export const SendGridAlertSchema = z
  .object({
    id: z.number(),
    type: z.string(),
    email_to: z.string().optional(),
    frequency: z.string().optional(),
    percentage: z.number().optional(),
    created_at: z.number().optional(),
    updated_at: z.number().optional(),
  })
  .passthrough();

export const AlertsListOutputSchema = PaginationMetaSchema.extend({
  alerts: z.array(SendGridAlertSchema),
});

export const MailSettingSummarySchema = z
  .object({
    title: z.string().optional(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const MailSettingsListOutputSchema = PaginationMetaSchema.extend({
  settings: z.array(MailSettingSummarySchema),
});

export const TrackingSettingSummarySchema = z
  .object({
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const TrackingSettingsListOutputSchema = PaginationMetaSchema.extend({
  settings: z.array(TrackingSettingSummarySchema),
});

export const InboundParseSettingSchema = z
  .object({
    url: z.string(),
    hostname: z.string(),
    spam_check: z.boolean().optional(),
    send_raw: z.boolean().optional(),
  })
  .passthrough();

export const InboundParseSettingsListOutputSchema = PaginationMetaSchema.extend({
  settings: z.array(InboundParseSettingSchema),
});

export const TemplateListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  versions: z.number().int().nonnegative(),
  activeSubject: z.string().nullable(),
  updatedAt: z.string(),
});

export const ListTemplatesOutputSchema = PaginationMetaSchema.extend({
  templates: z.array(TemplateListItemSchema),
});

export const TemplateHtmlOutputSchema = z.object({
  templateId: z.string(),
  versionId: z.string(),
  active: z.boolean(),
  name: z.string(),
  subject: z.string(),
  updatedAt: z.string(),
  htmlContent: z.string(),
});

export const MessageActivitySchema = z
  .object({
    msg_id: z.string(),
    from_email: z.string().optional(),
    to_email: z.string().optional(),
    subject: z.string().optional(),
    status: z.string().optional(),
    opens_count: z.number().optional(),
    clicks_count: z.number().optional(),
    last_event_time: z.string().optional(),
    last_timestamp: z.number().optional(),
  })
  .passthrough();

export const SearchMessageActivityOutputSchema = PaginationMetaSchema.extend({
  messages: z.array(MessageActivitySchema),
  source: z.enum(['activity', 'logs']).optional(),
  note: z.string().optional(),
});

export const EventWebhookSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    delivered: z.boolean().optional(),
    bounce: z.boolean().optional(),
    deferred: z.boolean().optional(),
    dropped: z.boolean().optional(),
    open: z.boolean().optional(),
    click: z.boolean().optional(),
    public_key: z.string().optional(),
    friendly_name: z.string().nullable().optional(),
    created_date: z.string().nullable().optional(),
    updated_date: z.string().optional(),
  })
  .passthrough();

export const EventWebhookListOutputSchema = PaginationMetaSchema.extend({
  maxAllowed: z.number().nullable(),
  webhooks: z.array(EventWebhookSchema),
});

export const WebhookReceiverStatusOutputSchema = z.object({
  enabled: z.boolean(),
  listening: z.boolean(),
  host: z.string().optional(),
  port: z.number().optional(),
  path: z.string().optional(),
  maxStoredEvents: z.number().int().nonnegative(),
  storedEvents: z.number().int().nonnegative(),
  eventTypeBreakdown: z.record(z.string(), z.number()),
  signatureRequired: z.boolean(),
  signatureConfigured: z.boolean(),
  lastReceivedAt: z.string().optional(),
  lastError: z.string().optional(),
});

export const ReceivedWebhookEventSchema = z.object({
  receivedAt: z.string(),
  signatureVerified: z.boolean(),
  payload: PassthroughRecordSchema,
});

export const ReceivedWebhookEventsOutputSchema = PaginationMetaSchema.extend({
  events: z.array(ReceivedWebhookEventSchema),
});

export const SuppressionEntrySchema = z.object({
  email: z.string(),
  created: z.number(),
  reason: z.string().optional(),
  status: z.string().optional(),
});

export const ListSuppressionsOutputSchema = PaginationMetaSchema.extend({
  type: z.string(),
  entries: z.array(SuppressionEntrySchema),
});

export const StatsDimensionSchema = z.enum([
  'global',
  'category',
  'category_sums',
  'mailbox_provider',
  'geo',
  'browser',
  'device',
  'client',
]);

export const EmailStatsOutputSchema = z.object({
  startDate: z.string(),
  endDate: z.string().nullable(),
  dimension: StatsDimensionSchema.optional(),
  aggregatedBy: z.enum(['day', 'week', 'month']).optional(),
  note: z.string().optional(),
  totals: z.object({
    requests: z.number(),
    delivered: z.number(),
    bounces: z.number(),
    opens: z.number(),
  }),
  series: z.array(PassthroughRecordSchema).optional(),
});

export const EmailLogsOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  messages: z.array(
    z
      .object({
        sg_message_id: z.string().optional(),
        from_email: z.string().optional(),
        to_email: z.string().optional(),
        subject: z.string().optional(),
        status: z.string().optional(),
        reason: z.string().optional(),
        sg_message_id_created_at: z.string().optional(),
      })
      .passthrough(),
  ),
});

export const ScopesOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  scopes: z.array(z.string()),
});

export const ManageEventWebhookOutputSchema = z.object({
  action: z.enum(['create', 'delete', 'test']),
  id: z.string().nullable(),
  url: z.string().nullable(),
  webhook: EventWebhookSchema.optional(),
});

export const SubuserSchema = z
  .object({
    id: z.number().optional(),
    username: z.string(),
    email: z.string().optional(),
    disabled: z.boolean().optional(),
    region: z.string().optional(),
  })
  .passthrough();

export const SubuserListOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  subusers: z.array(SubuserSchema),
});

export const DeleteSuppressionOutputSchema = z.object({
  deleted: z.boolean(),
  type: z.string(),
  email: z.string(),
  groupId: z.number().int().nullable(),
});

export const AsmGroupSuppressionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  suppressed: z.boolean(),
});
