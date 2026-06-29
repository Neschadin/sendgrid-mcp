import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  MailSettingName,
  SendGridClient,
  TrackingSettingName,
} from '../client';
import { ensureSafeToolRegistration } from './tool_utils';

const ConfirmTokenSchema = z
  .literal('CONFIRM')
  .describe('Safety token required for mutating SendGrid console settings');

const MailSettingNameSchema = z.enum([
  'address_whitelist',
  'bcc',
  'bounce_purge',
  'footer',
  'forward_bounce',
  'forward_spam',
  'plain_content',
  'spam_check',
  'template',
]);

const TrackingSettingNameSchema = z.enum([
  'click',
  'open',
  'subscription',
  'google_analytics',
]);

const SettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerConsoleSettingsTools(
  server: McpServer,
  client: SendGridClient,
) {
  ensureSafeToolRegistration(server);

  server.registerTool(
    'list_mail_settings',
    {
      description:
        'List SendGrid mail settings summaries (footer, bounce purge, spam check, etc.).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async (params) => ({
      content: [
        { type: 'text', text: jsonText(await client.listMailSettings(params)) },
      ],
    }),
  );

  server.registerTool(
    'get_mail_setting',
    {
      description: 'Read one SendGrid mail setting by name.',
      inputSchema: z.object({
        setting: MailSettingNameSchema,
      }),
    },
    async ({ setting }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.getMailSetting(setting as MailSettingName),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'list_tracking_settings',
    {
      description:
        'List SendGrid tracking settings summaries (click, open, subscription, etc.).',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        { type: 'text', text: jsonText(await client.listTrackingSettings()) },
      ],
    }),
  );

  server.registerTool(
    'get_tracking_setting',
    {
      description: 'Read one SendGrid tracking setting by name.',
      inputSchema: z.object({
        setting: TrackingSettingNameSchema,
      }),
    },
    async ({ setting }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.getTrackingSetting(setting as TrackingSettingName),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'list_inbound_parse_settings',
    {
      description: 'List inbound parse (receive email webhook) settings.',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: jsonText(await client.listInboundParseSettings()),
        },
      ],
    }),
  );

  server.registerTool(
    'update_mail_setting',
    {
      description:
        'Update one SendGrid mail setting (PATCH /mail_settings/{name}). Payload fields depend on setting type.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        setting: MailSettingNameSchema,
        settings: z
          .record(SettingValueSchema)
          .describe(
            'Setting payload, e.g. { "enabled": true } or footer { "enabled", "html_content", "plain_content" }',
          ),
      }),
    },
    async ({ setting, settings }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.updateMailSetting(
              setting as MailSettingName,
              settings,
            ),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'update_tracking_setting',
    {
      description:
        'Update one SendGrid tracking setting (click/open/subscription/google_analytics).',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        setting: TrackingSettingNameSchema,
        settings: z
          .record(SettingValueSchema)
          .describe(
            'Tracking payload, commonly { "enabled": true }. Open tracking may include substitution_tag.',
          ),
      }),
    },
    async ({ setting, settings }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.updateTrackingSetting(
              setting as TrackingSettingName,
              settings,
            ),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'create_inbound_parse_setting',
    {
      description:
        'Create inbound parse setting. Hostname MX must point to SendGrid.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        url: z.string().url(),
        hostname: z.string().min(1),
        spamCheck: z.boolean().optional(),
        sendRaw: z.boolean().optional(),
      }),
    },
    async ({ url, hostname, spamCheck, sendRaw }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.createInboundParseSetting({
              url,
              hostname,
              spam_check: spamCheck,
              send_raw: sendRaw,
            }),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'update_inbound_parse_setting',
    {
      description: 'Update inbound parse setting for a hostname.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        hostname: z.string().min(1),
        url: z.string().url().optional(),
        newHostname: z.string().min(1).optional(),
        spamCheck: z.boolean().optional(),
        sendRaw: z.boolean().optional(),
      }),
    },
    async ({ hostname, url, newHostname, spamCheck, sendRaw }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(
            await client.updateInboundParseSetting(hostname, {
              url,
              hostname: newHostname,
              spam_check: spamCheck,
              send_raw: sendRaw,
            }),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'delete_inbound_parse_setting',
    {
      description: 'Delete inbound parse setting by hostname.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        hostname: z.string().min(1),
      }),
    },
    async ({ hostname }) => {
      await client.deleteInboundParseSetting(hostname);
      return {
        content: [
          {
            type: 'text',
            text: `Inbound parse setting for hostname "${hostname}" deleted.`,
          },
        ],
      };
    },
  );
}
