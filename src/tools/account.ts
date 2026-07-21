import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SendGridClient } from '../client';
import {
  AlertsListOutputSchema,
  AuthenticatedDomainSchema,
  AuthenticatedDomainsListOutputSchema,
  BrandedLinkSchema,
  BrandedLinksListOutputSchema,
  jsonReadResult,
  jsonText,
  paginateArray,
  SendGridAlertSchema,
  UserAccountOutputSchema,
  UserCreditsOutputSchema,
  UserProfileOutputSchema,
  VerifiedSenderSchema,
  VerifiedSendersListOutputSchema,
} from './output_schemas';
import {
  ensureSafeToolRegistration,
  ListPagingInputFields,
  ReadInputFields,
} from './tool_utils';

const ConfirmTokenSchema = z
  .literal('CONFIRM')
  .describe('Safety token required for mutating SendGrid account settings');

export function registerAccountTools(server: McpServer, client: SendGridClient) {
  ensureSafeToolRegistration(server);

  server.registerTool(
    'get_account_info',
    {
      description:
        'Read SendGrid account overview (account type, reputation, and related metadata).',
      inputSchema: z.object({ ...ReadInputFields }),
      outputSchema: UserAccountOutputSchema,
    },
    async ({ response_format }) => {
      const data = await client.getUserAccount();
      return jsonReadResult(data, undefined, response_format);
    },
  );

  server.registerTool(
    'get_user_profile',
    {
      description: 'Read SendGrid user profile (company, address, contact fields).',
      inputSchema: z.object({ ...ReadInputFields }),
      outputSchema: UserProfileOutputSchema,
    },
    async ({ response_format }) => {
      const data = await client.getUserProfile();
      return jsonReadResult(data, undefined, response_format);
    },
  );

  server.registerTool(
    'get_user_credits',
    {
      description: 'Read SendGrid account email credits/quota overview.',
      inputSchema: z.object({ ...ReadInputFields }),
      outputSchema: UserCreditsOutputSchema,
    },
    async ({ response_format }) => {
      const data = await client.getUserCredits();
      return jsonReadResult(data, undefined, response_format);
    },
  );

  server.registerTool(
    'list_verified_senders',
    {
      description: 'List verified sender identities configured in SendGrid.',
      inputSchema: z.object({
        lastSeenID: z.number().int().optional(),
        id: z.number().int().optional(),
        ...ListPagingInputFields,
      }),
      outputSchema: VerifiedSendersListOutputSchema,
    },
    async (params) => {
      const senders = await client.listVerifiedSenders({
        limit: params.limit ?? 200,
        lastSeenID: params.lastSeenID,
        id: params.id,
      });
      const { items, pagination } = paginateArray(
        senders,
        params.limit,
        params.offset,
      );
      return jsonReadResult(
        { ...pagination, senders: items },
        jsonText(items),
        params.response_format,
      );
    },
  );

  server.registerTool(
    'get_verified_sender',
    {
      description: 'Read one verified sender identity by ID.',
      inputSchema: z.object({ id: z.number().int().positive(), ...ReadInputFields }),
      outputSchema: VerifiedSenderSchema,
    },
    async ({ id, response_format }) => {
      const sender = await client.getVerifiedSender(id);
      return jsonReadResult(sender, undefined, response_format);
    },
  );

  server.registerTool(
    'list_authenticated_domains',
    {
      description:
        'List domain authentication (whitelabel domain) records and DNS validation state.',
      inputSchema: z.object({ ...ListPagingInputFields }),
      outputSchema: AuthenticatedDomainsListOutputSchema,
    },
    async (params) => {
      const domains = await client.listAuthenticatedDomains();
      const { items, pagination } = paginateArray(
        domains,
        params.limit,
        params.offset,
      );
      return jsonReadResult(
        { ...pagination, domains: items },
        jsonText(items),
        params.response_format,
      );
    },
  );

  server.registerTool(
    'get_authenticated_domain',
    {
      description: 'Read one authenticated domain record by ID.',
      inputSchema: z.object({ id: z.number().int().positive(), ...ReadInputFields }),
      outputSchema: AuthenticatedDomainSchema,
    },
    async ({ id, response_format }) => {
      const domain = await client.getAuthenticatedDomain(id);
      return jsonReadResult(domain, undefined, response_format);
    },
  );

  server.registerTool(
    'list_branded_links',
    {
      description: 'List link branding (click-tracking domain) records.',
      inputSchema: z.object({ ...ListPagingInputFields }),
      outputSchema: BrandedLinksListOutputSchema,
    },
    async (params) => {
      const links = await client.listBrandedLinks();
      const { items, pagination } = paginateArray(
        links,
        params.limit,
        params.offset,
      );
      return jsonReadResult(
        { ...pagination, links: items },
        jsonText(items),
        params.response_format,
      );
    },
  );

  server.registerTool(
    'get_branded_link',
    {
      description: 'Read one branded link record by ID.',
      inputSchema: z.object({ id: z.number().int().positive(), ...ReadInputFields }),
      outputSchema: BrandedLinkSchema,
    },
    async ({ id, response_format }) => {
      const link = await client.getBrandedLink(id);
      return jsonReadResult(link, undefined, response_format);
    },
  );

  server.registerTool(
    'list_alerts',
    {
      description:
        'List SendGrid account alerts (usage limits and stats notifications).',
      inputSchema: z.object({ ...ListPagingInputFields }),
      outputSchema: AlertsListOutputSchema,
    },
    async (params) => {
      const alerts = await client.listAlerts();
      const { items, pagination } = paginateArray(
        alerts,
        params.limit,
        params.offset,
      );
      return jsonReadResult(
        { ...pagination, alerts: items },
        jsonText(items),
        params.response_format,
      );
    },
  );

  server.registerTool(
    'get_alert',
    {
      description: 'Read one SendGrid alert by ID.',
      inputSchema: z.object({ id: z.number().int().positive(), ...ReadInputFields }),
      outputSchema: SendGridAlertSchema,
    },
    async ({ id, response_format }) => {
      const alert = await client.getAlert(id);
      return jsonReadResult(alert, undefined, response_format);
    },
  );

  server.registerTool(
    'create_verified_sender',
    {
      description:
        'Create a verified sender identity. SendGrid emails a verification link to from_email.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        nickname: z.string().min(1).max(100),
        fromEmail: z.string().email().max(256),
        replyTo: z.string().email().max(256),
        fromName: z.string().max(256).optional(),
        replyToName: z.string().max(256).optional(),
        address: z.string().max(100).optional(),
        address2: z.string().max(100).optional(),
        state: z.string().max(2).optional(),
        city: z.string().max(150).optional(),
        country: z.string().max(100).optional(),
        zip: z.string().max(10).optional(),
      }),
    },
    async ({
      fromEmail,
      replyTo,
      nickname,
      fromName,
      replyToName,
      address,
      address2,
      state,
      city,
      country,
      zip,
    }) => {
      const created = await client.createVerifiedSender({
        nickname,
        from_email: fromEmail,
        reply_to: replyTo,
        from_name: fromName,
        reply_to_name: replyToName,
        address,
        address2,
        state,
        city,
        country,
        zip,
      });
      return {
        content: [{ type: 'text', text: jsonText(created) }],
      };
    },
  );

  server.registerTool(
    'resend_verified_sender_verification',
    {
      description: 'Resend verification email for a verified sender identity.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => {
      await client.resendVerifiedSenderVerification(id);
      return {
        content: [
          {
            type: 'text',
            text: `Verification email resent for verified sender ID ${id}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'delete_verified_sender',
    {
      description: 'Delete a verified sender identity by ID.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => {
      await client.deleteVerifiedSender(id);
      return {
        content: [
          { type: 'text', text: `Verified sender ID ${id} deleted.` },
        ],
      };
    },
  );

  server.registerTool(
    'create_authenticated_domain',
    {
      description:
        'Start domain authentication (whitelabel domain). Returns DNS records to configure.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        domain: z.string().min(1),
        subdomain: z.string().optional(),
        username: z.string().optional(),
        ips: z.array(z.string()).optional(),
        customSpf: z.boolean().optional(),
        default: z.boolean().optional(),
        automaticSecurity: z.boolean().optional(),
        customDkimSelector: z.string().optional(),
        region: z.enum(['global', 'eu']).optional(),
      }),
    },
    async ({
      domain,
      subdomain,
      username,
      ips,
      customSpf,
      default: isDefault,
      automaticSecurity,
      customDkimSelector,
      region,
    }) => {
      const created = await client.createAuthenticatedDomain({
        domain,
        subdomain,
        username,
        ips,
        custom_spf: customSpf,
        default: isDefault,
        automatic_security: automaticSecurity,
        custom_dkim_selector: customDkimSelector,
        region,
      });
      return {
        content: [{ type: 'text', text: jsonText(created) }],
      };
    },
  );

  server.registerTool(
    'validate_authenticated_domain',
    {
      description:
        'Validate DNS for an authenticated domain. Returns validation results and errors.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => ({
      content: [
        {
          type: 'text',
          text: jsonText(await client.validateAuthenticatedDomain(id)),
        },
      ],
    }),
  );

  server.registerTool(
    'validate_branded_link',
    {
      description:
        'Validate DNS for a branded link (click-tracking domain) by ID.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => ({
      content: [
        { type: 'text', text: jsonText(await client.validateBrandedLink(id)) },
      ],
    }),
  );

  server.registerTool(
    'update_branded_link',
    {
      description:
        'Update a branded link (e.g. set default=true for click-tracking domain).',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
        default: z.boolean().optional(),
        subdomain: z.string().optional(),
      }),
    },
    async ({ id, default: isDefault, subdomain }) => {
      const updated = await client.updateBrandedLink(id, {
        default: isDefault,
        subdomain,
      });
      return {
        content: [{ type: 'text', text: jsonText(updated) }],
      };
    },
  );

  server.registerTool(
    'create_alert',
    {
      description:
        'Create a SendGrid alert (usage_limit or stats_notification).',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        type: z.enum(['usage_limit', 'stats_notification']),
        emailTo: z.string().email().optional(),
        frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
        percentage: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ type, emailTo, frequency, percentage }) => {
      const created = await client.createAlert({
        type,
        email_to: emailTo,
        frequency,
        percentage,
      });
      return {
        content: [{ type: 'text', text: jsonText(created) }],
      };
    },
  );

  server.registerTool(
    'update_alert',
    {
      description: 'Update an existing SendGrid alert by ID.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
        type: z.enum(['usage_limit', 'stats_notification']).optional(),
        emailTo: z.string().email().optional(),
        frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
        percentage: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ id, type, emailTo, frequency, percentage }) => {
      const updated = await client.updateAlert(id, {
        type,
        email_to: emailTo,
        frequency,
        percentage,
      });
      return {
        content: [{ type: 'text', text: jsonText(updated) }],
      };
    },
  );

  server.registerTool(
    'delete_alert',
    {
      description: 'Delete a SendGrid alert by ID.',
      inputSchema: z.object({
        confirmToken: ConfirmTokenSchema,
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => {
      await client.deleteAlert(id);
      return {
        content: [{ type: 'text', text: `Alert ID ${id} deleted.` }],
      };
    },
  );
}
