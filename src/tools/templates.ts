import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SendGridClient } from '../client';
import { ensureSafeToolRegistration } from './tool_utils';

const ConfirmTokenSchema = z
  .literal('CONFIRM')
  .describe('Required for mutating SendGrid template state');

function requireConfirm(confirmToken: 'CONFIRM' | undefined, action: string) {
  if (confirmToken !== 'CONFIRM') {
    throw new Error(`Set confirmToken="CONFIRM" to ${action}.`);
  }
}

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
        confirmToken: ConfirmTokenSchema,
        templateId: z.string().describe('Template ID, e.g. d-xxxxxxxxxxxxxxxx'),
        newName: TemplateName.describe('New template name'),
      }),
    },
    async ({ confirmToken, templateId, newName }) => {
      requireConfirm(confirmToken, 'rename a template');
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
        confirmToken: ConfirmTokenSchema.optional(),
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
    async ({
      renames,
      dryRun,
      confirmToken,
      stopOnError,
      requireUniqueOldName,
    }) => {
      const wantDryRun = dryRun ?? false;
      if (!wantDryRun) {
        requireConfirm(confirmToken, 'rename templates in bulk');
      }
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
        confirmToken: ConfirmTokenSchema,
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
    async ({ confirmToken, name, versionName, subject, htmlContent }) => {
      requireConfirm(confirmToken, 'create a template');
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
              `Add to your template registry:`,
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
      inputSchema: z
        .object({
          confirmToken: ConfirmTokenSchema,
          templateId: z.string().describe('Template ID'),
          versionId: z.string().describe('Version ID to update'),
          htmlContent: z.string().optional().describe('New HTML content'),
          subject: z.string().optional().describe('New email subject'),
          name: z.string().optional().describe('New version label'),
        })
        .refine(
          (value) =>
            value.htmlContent !== undefined ||
            value.subject !== undefined ||
            value.name !== undefined,
          'Provide at least one of htmlContent, subject, or name.',
        ),
    },
    async ({
      confirmToken,
      templateId,
      versionId,
      htmlContent,
      subject,
      name,
    }) => {
      requireConfirm(confirmToken, 'update a template version');
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
        confirmToken: ConfirmTokenSchema,
        templateId: z.string().describe('Template ID'),
        versionId: z.string().describe('Version ID to activate'),
      }),
    },
    async ({ confirmToken, templateId, versionId }) => {
      requireConfirm(confirmToken, 'activate a template version');
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
    'prune_inactive_template_versions',
    {
      description:
        'Delete all inactive versions for one or more templates (keeps the active version only)',
      inputSchema: z.object({
        templateIds: z
          .array(z.string())
          .min(1)
          .describe('SendGrid template IDs to prune'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Default true. List versions that would be deleted without deleting'),
        confirmToken: ConfirmTokenSchema.optional(),
      }),
    },
    async ({ templateIds, dryRun = true, confirmToken }) => {
      if (!dryRun) {
        requireConfirm(confirmToken, 'delete inactive template versions');
      }
      const lines: string[] = [];
      let deleted = 0;
      let kept = 0;

      for (const templateId of templateIds) {
        const template = await client.getTemplate(templateId);
        const inactive = template.versions.filter((version) => version.active !== 1);
        const active = template.versions.filter((version) => version.active === 1);

        if (active.length !== 1) {
          lines.push(
            `WARN ${template.name} (${templateId}): expected 1 active version, found ${String(active.length)}`,
          );
        }

        for (const version of active) {
          lines.push(`keep active: ${template.name} / ${version.name} (${version.id})`);
          kept++;
        }

        for (const version of inactive) {
          if (dryRun) {
            lines.push(
              `would delete: ${template.name} / ${version.name} (${version.id})`,
            );
            continue;
          }

          await client.deleteTemplateVersion(templateId, version.id);
          lines.push(`deleted: ${template.name} / ${version.name} (${version.id})`);
          deleted++;
        }
      }

      lines.push('');
      lines.push(
        dryRun
          ? `Dry run complete for ${String(templateIds.length)} template(s).`
          : `Done. kept=${String(kept)} deleted=${String(deleted)}`,
      );

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
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
    async ({ templateId, confirmToken }) => {
      requireConfirm(confirmToken, 'delete a template');
      await client.deleteTemplate(templateId);
      return {
        content: [{ type: 'text', text: `🗑 Template ${templateId} deleted.` }],
      };
    },
  );
}
