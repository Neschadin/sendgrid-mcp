import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SendGridClient } from '../client';

export function registerTemplateTools(server: McpServer, client: SendGridClient) {
  server.registerTool(
    'list_templates',
    {
      description: 'List all dynamic SendGrid templates with their IDs, names, and version counts',
      inputSchema: {},
    },
    async () => {
      const { result } = await client.listTemplates();
      const rows = result.map((t) => {
        const active = t.versions.find((v) => v.active === 1);
        return `• [${t.id}] ${t.name}  (versions: ${t.versions.length}, active subject: "${active?.subject ?? '—'}", updated: ${t.updated_at})`;
      });
      return {
        content: [
          {
            type: 'text',
            text:
              result.length === 0
                ? 'No dynamic templates found.'
                : `Found ${result.length} dynamic template(s):\n\n${rows.join('\n')}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_template_html',
    {
      description: "Get full HTML content of a template's active (or specific) version",
      inputSchema: z.object({
        templateId: z.string().describe('Template ID, e.g. d-xxxxxxxxxxxxxxxx'),
        versionId: z
          .string()
          .optional()
          .describe('Version ID — omit to use the active version'),
      }),
    },
    async ({ templateId, versionId }) => {
      let resolvedVersionId = versionId;

      if (!resolvedVersionId) {
        const template = await client.getTemplate(templateId);
        const active = template.versions.find((v) => v.active === 1);
        if (!active) {
          return { content: [{ type: 'text', text: `Template ${templateId} has no active version.` }] };
        }
        resolvedVersionId = active.id;
      }

      const version = await client.getTemplateVersion(templateId, resolvedVersionId);
      return {
        content: [
          {
            type: 'text',
            text: [
              `Template: ${templateId}`,
              `Version:  ${version.id}  (active: ${version.active === 1 ? 'yes' : 'no'})`,
              `Name:     ${version.name}`,
              `Subject:  ${version.subject}`,
              `Updated:  ${version.updated_at}`,
              ``,
              `─── HTML ────────────────────────────────────────────────────`,
              version.html_content,
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_template',
    {
      description: 'Create a new dynamic template with a first version',
      inputSchema: z.object({
        name: z.string().describe('Template name, e.g. "listing.approved"'),
        versionName: z.string().describe('Version label, e.g. "v1"'),
        subject: z.string().describe('Email subject line (supports Handlebars: {{var}})'),
        htmlContent: z.string().describe('Full HTML body (supports Handlebars: {{var}})'),
      }),
    },
    async ({ name, versionName, subject, htmlContent }) => {
      const template = await client.createTemplate(name);
      const version = await client.createTemplateVersion(template.id, {
        name: versionName,
        subject,
        htmlContent,
        active: 1,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `✅ Template created`,
              `Template ID: ${template.id}`,
              `Version ID:  ${version.id}`,
              `Active:      yes`,
              ``,
              `Add to notifications.constants.ts:`,
              `  '${name}': '${template.id}',`,
            ].join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_template_html',
    {
      description: 'Update the HTML, subject, or name of a specific template version',
      inputSchema: z.object({
        templateId: z.string().describe('Template ID'),
        versionId: z.string().describe('Version ID to update'),
        htmlContent: z.string().optional().describe('New HTML content'),
        subject: z.string().optional().describe('New email subject'),
        name: z.string().optional().describe('New version label'),
      }),
    },
    async ({ templateId, versionId, htmlContent, subject, name }) => {
      const version = await client.updateTemplateVersion(templateId, versionId, {
        htmlContent,
        subject,
        name,
      });
      return {
        content: [
          {
            type: 'text',
            text: `✅ Version ${version.id} updated (${version.updated_at})`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'activate_template_version',
    {
      description:
        'Activate a specific version of a template (only one version can be active at a time)',
      inputSchema: z.object({
        templateId: z.string().describe('Template ID'),
        versionId: z.string().describe('Version ID to activate'),
      }),
    },
    async ({ templateId, versionId }) => {
      const version = await client.activateTemplateVersion(templateId, versionId);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Version "${version.name}" (${version.id}) is now active for template ${templateId}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'delete_template',
    {
      description:
        'Permanently delete a SendGrid template and all its versions. Use with caution.',
      inputSchema: z.object({
        templateId: z.string().describe('Template ID to delete'),
      }),
    },
    async ({ templateId }) => {
      await client.deleteTemplate(templateId);
      return {
        content: [{ type: 'text', text: `🗑 Template ${templateId} deleted.` }],
      };
    },
  );
}
