import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SendGridClient } from '../client';
import { SendRequestSchema, toMailSendPayload } from './preflight';

export function registerEmailTools(
  server: McpServer,
  client: SendGridClient,
  defaultFromEmail: string,
  defaultFromName: string,
) {
  const RecipientSchema = z.object({
    email: z.string().email(),
    name: z.string().optional(),
  });

  server.registerTool(
    'send_email_advanced',
    {
      description:
        'Send email with full /mail/send payload surface (content/template, tracking, asm, scheduling, categories, etc).',
      inputSchema: z.object({
        request: SendRequestSchema,
      }),
    },
    async ({ request }) => {
      const result = await client.sendMail(toMailSendPayload(request));

      return {
        content: [
          {
            type: 'text',
            text: [
              'Email accepted by SendGrid.',
              `Status code: ${result.statusCode}`,
              `Message ID: ${result.messageId || '(not returned)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'send_template_email_advanced',
    {
      description:
        'Send a dynamic-template email with optional cc/bcc, reply-to, asm, categories, custom args, and scheduling.',
      inputSchema: z.object({
        to: z.array(RecipientSchema).min(1),
        templateId: z.string().describe('Template ID, e.g. d-xxxxxxxxxxxxxxxx'),
        dynamicTemplateData: z.record(z.unknown()),
        subject: z.string().optional(),
        cc: z.array(RecipientSchema).optional(),
        bcc: z.array(RecipientSchema).optional(),
        fromEmail: z.string().email().optional(),
        fromName: z.string().optional(),
        replyTo: RecipientSchema.optional(),
        categories: z.array(z.string()).optional(),
        customArgs: z.record(z.string()).optional(),
        sendAt: z.number().int().optional(),
        batchId: z.string().optional(),
        asmGroupId: z.number().int().optional(),
        asmGroupsToDisplay: z.array(z.number().int()).optional(),
        mailSettings: z.record(z.unknown()).optional(),
        trackingSettings: z.record(z.unknown()).optional(),
      }),
    },
    async ({
      to,
      templateId,
      dynamicTemplateData,
      subject,
      cc,
      bcc,
      fromEmail,
      fromName,
      replyTo,
      categories,
      customArgs,
      sendAt,
      batchId,
      asmGroupId,
      asmGroupsToDisplay,
      mailSettings,
      trackingSettings,
    }) => {
      const result = await client.sendMail({
        personalizations: [
          {
            to,
            cc,
            bcc,
            dynamic_template_data: dynamicTemplateData,
          },
        ],
        from: {
          email: fromEmail ?? defaultFromEmail,
          name: fromName ?? defaultFromName,
        },
        reply_to: replyTo,
        subject,
        template_id: templateId,
        categories,
        custom_args: customArgs,
        send_at: sendAt,
        batch_id: batchId,
        asm:
          asmGroupId !== undefined
            ? {
                group_id: asmGroupId,
                groups_to_display: asmGroupsToDisplay,
              }
            : undefined,
        mail_settings: mailSettings,
        tracking_settings: trackingSettings,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              'Template email accepted by SendGrid.',
              `Template: ${templateId}`,
              `Recipients: ${to.length}`,
              `Status code: ${result.statusCode}`,
              `Message ID: ${result.messageId || '(not returned)'}`,
              batchId ? `Batch ID: ${batchId}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'send_sandbox_email',
    {
      description:
        'Send using mail_settings.sandbox_mode=true for payload/template validation without live recipient delivery.',
      inputSchema: z.object({
        request: SendRequestSchema,
      }),
    },
    async ({ request }) => {
      const payload = toMailSendPayload(request);
      payload.mail_settings = {
        ...(payload.mail_settings ?? {}),
        sandbox_mode: { enable: true },
      };

      const result = await client.sendMail(payload);

      return {
        content: [
          {
            type: 'text',
            text: [
              'Sandbox send accepted by SendGrid.',
              'No live delivery attempted.',
              `Status code: ${result.statusCode}`,
              `Message ID: ${result.messageId || '(not returned)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_batch_id',
    {
      description:
        'Create a SendGrid batch ID for scheduled sends and later pause/cancel control.',
      inputSchema: {},
    },
    async () => {
      const batch = await client.createBatchId();
      return {
        content: [{ type: 'text', text: `Batch ID: ${batch.batch_id}` }],
      };
    },
  );

  server.registerTool(
    'schedule_email',
    {
      description:
        'Schedule an email by setting send_at. Creates batch ID automatically when not provided.',
      inputSchema: z.object({
        request: SendRequestSchema,
        sendAt: z.number().int().describe('Unix timestamp in seconds'),
        batchId: z.string().optional(),
        autoCreateBatchId: z
          .boolean()
          .optional()
          .describe(
            'Default true. If false and batchId missing, sends without batch control',
          ),
      }),
    },
    async ({ request, sendAt, batchId, autoCreateBatchId }) => {
      const now = Math.floor(Date.now() / 1000);
      if (sendAt <= now) {
        throw new Error(
          `sendAt must be in the future. Received ${sendAt}, now is ${now}.`,
        );
      }

      let effectiveBatchId = batchId;
      if (!effectiveBatchId && (autoCreateBatchId ?? true)) {
        effectiveBatchId = (await client.createBatchId()).batch_id;
      }

      const result = await client.sendMail(
        toMailSendPayload({
          ...request,
          sendAt,
          batchId: effectiveBatchId,
        }),
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              'Scheduled email accepted by SendGrid.',
              `send_at: ${sendAt}`,
              effectiveBatchId
                ? `Batch ID: ${effectiveBatchId}`
                : 'Batch ID: (none)',
              `Status code: ${result.statusCode}`,
              `Message ID: ${result.messageId || '(not returned)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'pause_scheduled_send',
    {
      description: 'Pause a scheduled send batch by batch ID.',
      inputSchema: z.object({
        batchId: z.string(),
      }),
    },
    async ({ batchId }) => {
      const result = await client.upsertScheduledSend(batchId, 'pause');
      return {
        content: [
          {
            type: 'text',
            text: `Scheduled send ${result.batch_id} status: ${result.status}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'resume_scheduled_send',
    {
      description:
        'Resume a previously paused/canceled batch by deleting its scheduled-send status.',
      inputSchema: z.object({
        batchId: z.string(),
      }),
    },
    async ({ batchId }) => {
      await client.resumeScheduledSend(batchId);
      return {
        content: [
          {
            type: 'text',
            text: `Scheduled send ${batchId} resumed (status entry removed).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'cancel_scheduled_send',
    {
      description:
        'Cancel a scheduled send batch. This is not guaranteed close to send time.',
      inputSchema: z.object({
        batchId: z.string(),
      }),
    },
    async ({ batchId }) => {
      const result = await client.upsertScheduledSend(batchId, 'cancel');
      return {
        content: [
          {
            type: 'text',
            text: `Scheduled send ${result.batch_id} status: ${result.status}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'send_test_email',
    {
      description:
        'Send a test email using a template with mock data to a given address',
      inputSchema: z.object({
        to: z.string().email().describe('Recipient email for the test'),
        templateId: z.string().describe('Template ID, e.g. d-xxxxxxxxxxxxxxxx'),
        mockData: z
          .record(z.unknown())
          .describe(
            'Mock dynamic template data as JSON, e.g. {"listingTitle":"Test Co","siteUrl":"https://kennitalan.is"}',
          ),
        fromEmail: z
          .string()
          .email()
          .optional()
          .describe('Override sender email'),
        fromName: z.string().optional().describe('Override sender name'),
      }),
    },
    async ({ to, templateId, mockData, fromEmail, fromName }) => {
      const result = await client.sendMail({
        personalizations: [
          {
            to: [{ email: to }],
            dynamic_template_data: mockData as Record<string, unknown>,
          },
        ],
        from: {
          email: fromEmail ?? defaultFromEmail,
          name: fromName ?? defaultFromName,
        },
        template_id: templateId,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `✅ Test email sent`,
              `To:         ${to}`,
              `Template:   ${templateId}`,
              `Status:     ${result.statusCode}`,
              `Message ID: ${result.messageId || '(not returned)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );
}
