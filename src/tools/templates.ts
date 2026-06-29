import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SendGridClient } from '../client';
import { ensureSafeToolRegistration } from './tool_utils';

export function registerTemplateTools(
  server: McpServer,
  client: SendGridClient,
) {
  ensureSafeToolRegistration(server);
  const TemplateName = z
    .string()
    .min(1)
    .max(100)
    .describe('Template name (max 100 chars)');

  const ListTemplatesOutputSchema = z.object({
    count: z.number().int().nonnegative(),
    templates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        versions: z.number().int().nonnegative(),
        activeSubject: z.string().nullable(),
        updatedAt: z.string(),
      }),
    ),
  });

  server.registerTool(
    'list_templates',
    {
      description:
        'List all dynamic SendGrid templates with their IDs, names, and version counts',
      inputSchema: z.object({}),
      outputSchema: ListTemplatesOutputSchema,
    },
    async () => {
      const result = await client.listAllDynamicTemplates(200);
      const templates = result.map((t) => {
        const active = t.versions.find((v) => v.active === 1);
        return {
          id: t.id,
          name: t.name,
          versions: t.versions.length,
          activeSubject: active?.subject ?? null,
          updatedAt: t.updated_at,
        };
      });
      const rows = result.map((t) => {
        const active = t.versions.find((v) => v.active === 1);
        return `• [${t.id}] ${t.name}  (versions: ${t.versions.length}, active subject: "${active?.subject ?? '—'}", updated: ${t.updated_at})`;
      });
      return {
        structuredContent: {
          count: templates.length,
          templates,
        },
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
    'rename_template',
    {
      description:
        'Rename a dynamic template (updates the template name, not a version label)',
      inputSchema: z.object({
        templateId: z.string().describe('Template ID, e.g. d-xxxxxxxxxxxxxxxx'),
        newName: TemplateName.describe('New template name'),
      }),
    },
    async ({ templateId, newName }) => {
      const updated = await client.updateTemplate(templateId, {
        name: newName,
      });
      return {
        content: [
          {
            type: 'text',
            text: `✅ Renamed template ${updated.id} → "${updated.name}" (updated: ${updated.updated_at})`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'rename_templates_bulk',
    {
      description:
        'Bulk rename templates by ID and/or current name. Supports dry-run and stop-on-error.',
      inputSchema: z.object({
        renames: z
          .array(
            z.object({
              templateId: z
                .string()
                .optional()
                .describe('Template ID to rename'),
              oldName: z
                .string()
                .optional()
                .describe('Current template name to match'),
              newName: TemplateName.describe('New template name'),
            }),
          )
          .min(1)
          .describe(
            'Rename operations. Provide templateId or oldName for each item.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe('If true, only print planned changes'),
        stopOnError: z
          .boolean()
          .optional()
          .describe('If true, stop after the first failed rename'),
        requireUniqueOldName: z
          .boolean()
          .optional()
          .describe('If true, oldName must match exactly one template'),
      }),
    },
    async ({ renames, dryRun, stopOnError, requireUniqueOldName }) => {
      const wantDryRun = dryRun ?? false;
      const wantStopOnError = stopOnError ?? false;
      const wantRequireUnique = requireUniqueOldName ?? true;

      const templates = await client.listAllDynamicTemplates(200);
      const byId = new Map(templates.map((t) => [t.id, t]));
      const byName = new Map<string, typeof templates>();
      for (const t of templates) {
        const arr = byName.get(t.name) ?? [];
        arr.push(t);
        byName.set(t.name, arr);
      }

      type PlanItem =
        | { kind: 'ok'; templateId: string; oldName: string; newName: string }
        | {
            kind: 'skip';
            reason: string;
            templateId?: string;
            oldName?: string;
            newName: string;
          }
        | {
            kind: 'error';
            reason: string;
            templateId?: string;
            oldName?: string;
            newName: string;
          };

      const plan: PlanItem[] = [];

      for (const r of renames) {
        if (!r.templateId && !r.oldName) {
          plan.push({
            kind: 'error',
            reason: 'missing both templateId and oldName',
            newName: r.newName,
          });
          if (wantStopOnError) break;
          continue;
        }

        let resolved = r.templateId ? byId.get(r.templateId) : undefined;
        if (!resolved && r.oldName) {
          const matches = byName.get(r.oldName) ?? [];
          if (matches.length === 0) {
            plan.push({
              kind: 'error',
              reason: `oldName not found: "${r.oldName}"`,
              oldName: r.oldName,
              newName: r.newName,
            });
            if (wantStopOnError) break;
            continue;
          }
          if (wantRequireUnique && matches.length !== 1) {
            plan.push({
              kind: 'error',
              reason: `oldName is not unique ("${r.oldName}" matches ${matches.length} templates: ${matches
                .map((m) => m.id)
                .join(', ')})`,
              oldName: r.oldName,
              newName: r.newName,
            });
            if (wantStopOnError) break;
            continue;
          }
          resolved = matches[0];
        }

        if (!resolved) {
          plan.push({
            kind: 'error',
            reason: `templateId not found: "${r.templateId}"`,
            templateId: r.templateId,
            oldName: r.oldName,
            newName: r.newName,
          });
          if (wantStopOnError) break;
          continue;
        }

        if (resolved.name === r.newName) {
          plan.push({
            kind: 'skip',
            reason: 'no-op (already has that name)',
            templateId: resolved.id,
            oldName: resolved.name,
            newName: r.newName,
          });
          continue;
        }

        plan.push({
          kind: 'ok',
          templateId: resolved.id,
          oldName: resolved.name,
          newName: r.newName,
        });
      }

      const lines: string[] = [];
      const okCount = plan.filter((p) => p.kind === 'ok').length;
      const skipCount = plan.filter((p) => p.kind === 'skip').length;
      const errCount = plan.filter((p) => p.kind === 'error').length;

      if (wantDryRun) {
        lines.push(
          `🧪 Dry run. Planned: ok=${okCount}, skip=${skipCount}, error=${errCount}`,
        );
        for (const p of plan) {
          if (p.kind === 'ok')
            lines.push(
              `- ✅ [${p.templateId}] "${p.oldName}" → "${p.newName}"`,
            );
          if (p.kind === 'skip')
            lines.push(
              `- ⏭  [${p.templateId ?? '—'}] ${p.reason}: "${p.oldName ?? p.oldName ?? '—'}"`,
            );
          if (p.kind === 'error')
            lines.push(
              `- ❌ ${p.reason} (templateId=${p.templateId ?? '—'}, oldName=${p.oldName ?? '—'}, newName="${p.newName}")`,
            );
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      lines.push(
        `Executing renames: ok=${okCount}, skip=${skipCount}, error=${errCount}`,
      );

      const results: Array<{
        templateId: string;
        status: 'renamed' | 'failed';
        message: string;
      }> = [];
      for (const p of plan) {
        if (p.kind !== 'ok') continue;
        try {
          const updated = await client.updateTemplate(p.templateId, {
            name: p.newName,
          });
          results.push({
            templateId: updated.id,
            status: 'renamed',
            message: `"${p.oldName}" → "${updated.name}" (${updated.updated_at})`,
          });
        } catch (e) {
          const msg = String(e);
          results.push({
            templateId: p.templateId,
            status: 'failed',
            message: msg,
          });
          if (wantStopOnError) break;
        }
      }

      for (const r of results) {
        lines.push(
          r.status === 'renamed'
            ? `- ✅ [${r.templateId}] ${r.message}`
            : `- ❌ [${r.templateId}] ${r.message}`,
        );
      }

      const failed = results.filter((r) => r.status === 'failed').length;
      if (failed > 0)
        lines.push(
          `\nFailures: ${failed}. Re-run with dryRun=true to inspect plan.`,
        );

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'get_template_html',
    {
      description:
        "Get full HTML content of a template's active (or specific) version",
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
          return {
            content: [
              {
                type: 'text',
                text: `Template ${templateId} has no active version.`,
              },
            ],
          };
        }
        resolvedVersionId = active.id;
      }

      const version = await client.getTemplateVersion(
        templateId,
        resolvedVersionId,
      );
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
        subject: z
          .string()
          .describe('Email subject line (supports Handlebars: {{var}})'),
        htmlContent: z
          .string()
          .describe('Full HTML body (supports Handlebars: {{var}})'),
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
      description:
        'Update the HTML, subject, or name of a specific template version',
      inputSchema: z.object({
        templateId: z.string().describe('Template ID'),
        versionId: z.string().describe('Version ID to update'),
        htmlContent: z.string().optional().describe('New HTML content'),
        subject: z.string().optional().describe('New email subject'),
        name: z.string().optional().describe('New version label'),
      }),
    },
    async ({ templateId, versionId, htmlContent, subject, name }) => {
      const version = await client.updateTemplateVersion(
        templateId,
        versionId,
        {
          htmlContent,
          subject,
          name,
        },
      );
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
      const version = await client.activateTemplateVersion(
        templateId,
        versionId,
      );
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
        confirmToken: z
          .literal('CONFIRM')
          .describe('Safety token required for destructive operations'),
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
