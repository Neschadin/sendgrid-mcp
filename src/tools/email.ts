import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SendGridClient } from '../client';

export function registerEmailTools(
  server: McpServer,
  client: SendGridClient,
  defaultFromEmail: string,
  defaultFromName: string,
) {
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
      const { messageId } = await client.sendEmail({
        to,
        templateId,
        dynamicTemplateData: mockData as Record<string, unknown>,
        fromEmail: fromEmail ?? defaultFromEmail,
        fromName: fromName ?? defaultFromName,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `✅ Test email sent`,
              `To:         ${to}`,
              `Template:   ${templateId}`,
              `Message ID: ${messageId || '(not returned)'}`,
            ].join('\n'),
          },
        ],
      };
    },
  );
}
