import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  isSendGridApiError,
  type SendGridClient,
  type SendGridMailSendPayload,
} from '../client';
import { ensureSafeToolRegistration } from './tool_utils';

const PROVIDER_FREE_FROM_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'aol.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
]);

const EmailAddressSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const AttachmentSchema = z.object({
  content: z.string().min(1),
  filename: z.string().min(1),
  type: z.string().optional(),
  disposition: z.enum(['attachment', 'inline']).optional(),
  contentId: z.string().optional(),
});

const ContentSchema = z.object({
  type: z.string().min(1),
  value: z.string(),
});

const PersonalizationSchema = z.object({
  to: z.array(EmailAddressSchema).min(1),
  cc: z.array(EmailAddressSchema).optional(),
  bcc: z.array(EmailAddressSchema).optional(),
  subject: z.string().optional(),
  dynamicTemplateData: z.record(z.unknown()).optional(),
  customArgs: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  sendAt: z.number().int().optional(),
});

const AsmSchema = z.object({
  groupId: z.number().int(),
  groupsToDisplay: z.array(z.number().int()).optional(),
});

export const SendRequestSchema = z.object({
  personalizations: z.array(PersonalizationSchema).min(1),
  from: EmailAddressSchema,
  replyTo: EmailAddressSchema.optional(),
  subject: z.string().optional(),
  content: z.array(ContentSchema).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  templateId: z.string().optional(),
  categories: z.array(z.string()).optional(),
  customArgs: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  sendAt: z.number().int().optional(),
  batchId: z.string().optional(),
  asm: AsmSchema.optional(),
  ipPoolName: z.string().optional(),
  mailSettings: z.record(z.unknown()).optional(),
  trackingSettings: z.record(z.unknown()).optional(),
});

export type SendRequestInput = z.infer<typeof SendRequestSchema>;

type PreflightSeverity = 'blocker' | 'warning' | 'info';

interface PreflightIssue {
  severity: PreflightSeverity;
  code: string;
  message: string;
}

interface PreflightOptions {
  checkSenderIdentity: boolean;
  partnerAccountId?: string;
}

export interface PreflightReport {
  ok: boolean;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  info: PreflightIssue[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function extractDomain(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? '';
}

function isValidBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length === 0 || normalized.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false;

  try {
    const decoded = Uint8Array.from(atob(normalized), (char) =>
      char.charCodeAt(0),
    );
    if (decoded.length === 0) return false;
    let binary = '';
    for (const byte of decoded) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=+$/u, '') === normalized.replace(/=+$/u, '');
  } catch {
    return false;
  }
}

function hasAnyPlainOrHtmlContent(request: SendRequestInput): boolean {
  return request.content?.some((item) => item.value.trim().length > 0) === true;
}

function hasAnySubject(
  request: SendRequestInput,
  templateSubject?: string,
): boolean {
  if (request.subject?.trim()) return true;
  if (templateSubject?.trim()) return true;

  return request.personalizations.every(
    (p) => typeof p.subject === 'string' && p.subject.trim().length > 0,
  );
}

function pushIssue(
  issues: PreflightIssue[],
  severity: PreflightSeverity,
  code: string,
  message: string,
) {
  issues.push({ severity, code, message });
}

export function toMailSendPayload(
  request: SendRequestInput,
): SendGridMailSendPayload {
  return {
    personalizations: request.personalizations.map((p) => ({
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      dynamic_template_data: p.dynamicTemplateData,
      custom_args: p.customArgs,
      headers: p.headers,
      send_at: p.sendAt,
    })),
    from: request.from,
    reply_to: request.replyTo,
    subject: request.subject,
    content: request.content,
    attachments: request.attachments?.map((attachment) => ({
      content: attachment.content,
      filename: attachment.filename,
      type: attachment.type,
      disposition: attachment.disposition,
      content_id: attachment.contentId,
    })),
    template_id: request.templateId,
    categories: request.categories,
    custom_args: request.customArgs,
    headers: request.headers,
    send_at: request.sendAt,
    batch_id: request.batchId,
    asm: request.asm
      ? {
          group_id: request.asm.groupId,
          groups_to_display: request.asm.groupsToDisplay,
        }
      : undefined,
    ip_pool_name: request.ipPoolName,
    mail_settings: request.mailSettings,
    tracking_settings: request.trackingSettings,
  };
}

function formatReport(report: PreflightReport): string {
  const lines = [
    `Preflight result: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Blockers: ${report.blockers.length}`,
    `Warnings: ${report.warnings.length}`,
    `Info: ${report.info.length}`,
    '',
  ];

  for (const issue of report.blockers) {
    lines.push(`[BLOCKER] ${issue.code}: ${issue.message}`);
  }
  for (const issue of report.warnings) {
    lines.push(`[WARN] ${issue.code}: ${issue.message}`);
  }
  for (const issue of report.info) {
    lines.push(`[INFO] ${issue.code}: ${issue.message}`);
  }

  if (
    report.blockers.length === 0 &&
    report.warnings.length === 0 &&
    report.info.length === 0
  ) {
    lines.push('No issues detected.');
  }

  return lines.join('\n');
}

export async function runSendPreflight(
  client: SendGridClient,
  request: SendRequestInput,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const issues: PreflightIssue[] = [];

  // Each personalization block must not repeat the same address across to/cc/bcc.
  request.personalizations.forEach((personalization, index) => {
    const seen = new Set<string>();
    const all = [
      ...(personalization.to ?? []),
      ...(personalization.cc ?? []),
      ...(personalization.bcc ?? []),
    ];
    for (const recipient of all) {
      const email = normalizeEmail(recipient.email);
      if (seen.has(email)) {
        pushIssue(
          issues,
          'blocker',
          'DUPLICATE_RECIPIENT',
          `personalizations[${index}] contains duplicate recipient in to/cc/bcc: ${email}`,
        );
      }
      seen.add(email);
    }
  });

  if (!request.templateId) {
    if (!hasAnyPlainOrHtmlContent(request)) {
      pushIssue(
        issues,
        'blocker',
        'MISSING_CONTENT',
        'Non-template send must include non-empty content.',
      );
    }

    if (!hasAnySubject(request)) {
      pushIssue(
        issues,
        'blocker',
        'MISSING_SUBJECT',
        'Subject is required unless every personalization provides one.',
      );
    }
  } else if (request.content && request.content.length > 0) {
    pushIssue(
      issues,
      'warning',
      'CONTENT_IGNORED_WITH_TEMPLATE',
      'content is usually ignored when templateId is provided.',
    );
  }

  for (const attachment of request.attachments ?? []) {
    if (!isValidBase64(attachment.content)) {
      pushIssue(
        issues,
        'blocker',
        'ATTACHMENT_NOT_BASE64',
        `Attachment "${attachment.filename}" is not valid base64.`,
      );
    }

    if (/\.(exe|js|vbs|cmd|bat|scr|jar)$/iu.test(attachment.filename)) {
      pushIssue(
        issues,
        'warning',
        'ATTACHMENT_HIGH_RISK_EXTENSION',
        `Attachment "${attachment.filename}" may be rejected by mailbox providers.`,
      );
    }
  }

  const htmlBodies =
    request.content
      ?.filter((item) => item.type.toLowerCase() === 'text/html')
      .map((item) => item.value) ?? [];
  for (const html of htmlBodies) {
    if (/<v:roundrect\b/iu.test(html)) {
      pushIssue(
        issues,
        'warning',
        'VML_ROUNDRECT_TRACKING',
        'VML roundrect links may break click tracking in Outlook Classic.',
      );
    }
    if (/<script\b[^>]*data-cf/iu.test(html)) {
      pushIssue(
        issues,
        'warning',
        'CLOUDFLARE_SCRIPT_TAG_DETECTED',
        'Cloudflare bot-detection script tags may trigger Gmail attachment/security blocking.',
      );
    }
  }

  if (request.templateId) {
    try {
      const template = await client.getTemplate(request.templateId);
      const activeVersion = template.versions.find(
        (version) => version.active === 1,
      );

      if (!activeVersion) {
        pushIssue(
          issues,
          'blocker',
          'TEMPLATE_HAS_NO_ACTIVE_VERSION',
          `Template ${request.templateId} exists but has no active version.`,
        );
      } else if (!hasAnySubject(request, activeVersion.subject)) {
        pushIssue(
          issues,
          'blocker',
          'MISSING_SUBJECT_WITH_TEMPLATE',
          'Template send has no subject in request and active template subject is empty.',
        );
      }
    } catch (error) {
      if (isSendGridApiError(error) && error.status === 404) {
        pushIssue(
          issues,
          'blocker',
          'INVALID_TEMPLATE_ID',
          `Template ${request.templateId} was not found.`,
        );
      } else {
        pushIssue(
          issues,
          'blocker',
          'TEMPLATE_LOOKUP_FAILED',
          `Could not validate template ${request.templateId}: ${String(error)}`,
        );
      }
    }
  }

  const senderDomain = extractDomain(request.from.email);
  if (PROVIDER_FREE_FROM_DOMAINS.has(senderDomain)) {
    pushIssue(
      issues,
      'warning',
      'FREE_MAILBOX_FROM_DOMAIN',
      `From domain "${senderDomain}" is often DMARC-sensitive for API sends.`,
    );
  }

  if (options.checkSenderIdentity) {
    try {
      const [domains, senders, links] = await Promise.all([
        client.listAuthenticatedDomains(),
        client.listVerifiedSenders({ limit: 200 }),
        client.listBrandedLinks(),
      ]);

      const senderEmail = normalizeEmail(request.from.email);
      const domainAuthenticated = domains.some((domain) => {
        if (!domain.domain || domain.valid === false) return false;
        const root = domain.domain.toLowerCase();
        return senderDomain === root || senderDomain.endsWith(`.${root}`);
      });

      const senderVerified = senders.some(
        (sender) =>
          sender.verified === true &&
          typeof sender.from_email === 'string' &&
          normalizeEmail(sender.from_email) === senderEmail,
      );

      if (!domainAuthenticated && !senderVerified) {
        pushIssue(
          issues,
          'blocker',
          'UNVERIFIED_SENDER_IDENTITY',
          `From address ${request.from.email} is not matched by authenticated domains or verified senders.`,
        );
      } else if (!domainAuthenticated && senderVerified) {
        pushIssue(
          issues,
          'warning',
          'SINGLE_SENDER_ONLY',
          `Sender ${request.from.email} is verified, but no authenticated domain match was found.`,
        );
      }

      if (links.length === 0) {
        pushIssue(
          issues,
          'warning',
          'NO_LINK_BRANDING',
          'No link branding found; tracked links may use sendgrid.net.',
        );
      } else if (!links.some((link) => link.default === true)) {
        pushIssue(
          issues,
          'warning',
          'NO_DEFAULT_LINK_BRANDING',
          'No default link branding is configured.',
        );
      } else if (
        !links.some((link) => {
          const domain = link.domain?.toLowerCase();
          if (!domain) return false;
          return senderDomain === domain || senderDomain.endsWith(`.${domain}`);
        })
      ) {
        pushIssue(
          issues,
          'warning',
          'LINK_BRANDING_DOMAIN_MISMATCH',
          `From domain ${senderDomain} is not aligned with current branded-link domains.`,
        );
      }
    } catch (error) {
      pushIssue(
        issues,
        'warning',
        'SENDER_CHECK_FAILED',
        `Sender identity checks could not be completed: ${String(error)}`,
      );
    }
  }

  if (options.partnerAccountId) {
    try {
      const state = await client.getPartnerAccountState(
        options.partnerAccountId,
      );
      if (state.state !== 'activated') {
        pushIssue(
          issues,
          'blocker',
          'ACCOUNT_NOT_ACTIVATED',
          `Partner account state is "${state.state}", expected "activated".`,
        );
      }
    } catch (error) {
      pushIssue(
        issues,
        'warning',
        'ACCOUNT_STATE_UNAVAILABLE',
        `Could not retrieve partner account state: ${String(error)}`,
      );
    }
  }

  const blockers = issues.filter((issue) => issue.severity === 'blocker');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const info = issues.filter((issue) => issue.severity === 'info');

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    info,
  };
}

export function registerPreflightTools(
  server: McpServer,
  client: SendGridClient,
) {
  ensureSafeToolRegistration(server);
  const PreflightOutputSchema = z.object({
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

  server.registerTool(
    'validate_send_request',
    {
      description:
        'Run SendGrid preflight checks for payload validity, template/sender health, and deliverability risks.',
      inputSchema: z.object({
        request: SendRequestSchema,
        partnerAccountId: z
          .string()
          .optional()
          .describe(
            'Optional partner account ID for /partners/accounts/{id}/state check',
          ),
        checkSenderIdentity: z
          .boolean()
          .optional()
          .describe(
            'Enable sender/domain/link-branding checks (default: true)',
          ),
      }),
      outputSchema: PreflightOutputSchema,
    },
    async ({ request, partnerAccountId, checkSenderIdentity }) => {
      const report = await runSendPreflight(client, request, {
        partnerAccountId,
        checkSenderIdentity: checkSenderIdentity ?? true,
      });

      return {
        structuredContent: report,
        content: [{ type: 'text', text: formatReport(report) }],
      };
    },
  );

  server.registerTool(
    'send_with_preflight',
    {
      description:
        'Validate then send. The email is sent only if no blocking preflight issues are found.',
      inputSchema: z.object({
        request: SendRequestSchema,
        partnerAccountId: z.string().optional(),
        checkSenderIdentity: z.boolean().optional(),
        abortOnWarnings: z
          .boolean()
          .optional()
          .describe('If true, warnings also block sending (default: false)'),
      }),
      outputSchema: z.object({
        sent: z.boolean(),
        report: PreflightOutputSchema,
        statusCode: z.number().nullable(),
        messageId: z.string().nullable(),
      }),
    },
    async ({
      request,
      partnerAccountId,
      checkSenderIdentity,
      abortOnWarnings,
    }) => {
      const report = await runSendPreflight(client, request, {
        partnerAccountId,
        checkSenderIdentity: checkSenderIdentity ?? true,
      });

      const shouldAbort =
        report.blockers.length > 0 ||
        (abortOnWarnings === true && report.warnings.length > 0);

      if (shouldAbort) {
        return {
          structuredContent: {
            sent: false,
            report,
            statusCode: null,
            messageId: null,
          },
          content: [
            {
              type: 'text',
              text: [
                'Send skipped due to preflight findings.',
                '',
                formatReport(report),
              ].join('\n'),
            },
          ],
        };
      }

      const sendResult = await client.sendMail(toMailSendPayload(request));

      return {
        structuredContent: {
          sent: true,
          report,
          statusCode: sendResult.statusCode,
          messageId: sendResult.messageId || null,
        },
        content: [
          {
            type: 'text',
            text: [
              'Email accepted by SendGrid.',
              `Status code: ${sendResult.statusCode}`,
              `Message ID: ${sendResult.messageId || '(not returned)'}`,
              '',
              formatReport(report),
            ].join('\n'),
          },
        ],
      };
    },
  );
}
