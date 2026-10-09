import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SendGridClient } from '../client';
import {
  jsonReadResult,
  SyncTemplateIdsOutputSchema,
} from './output_schemas';
import { ensureSafeToolRegistration } from './tool_utils';

const ConstantsPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => /\.(ts|js|mjs|cjs)$/iu.test(value),
    'constantsPath must be a .ts, .js, .mjs, or .cjs file',
  )
  .describe(
    'Absolute path to a local file that exports or defines SENDGRID_TEMPLATES.',
  );

/**
 * Parse SENDGRID_TEMPLATES object from the source file.
 * Returns a map of eventKey → templateId.
 */
function parseTemplatesFromSource(source: string): Record<string, string> {
  const result: Record<string, string> = {};

  const blockMatch = source.match(/SENDGRID_TEMPLATES\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return result;

  const block = blockMatch[1];
  if (!block) return result;
  const lineRe = /['"]?([\w.]+)['"]?\s*:\s*['"]([^'"]+)['"]/g;
  for (const match of block.matchAll(lineRe)) {
    const key = match[1];
    const templateId = match[2];
    if (!key || !templateId) continue;
    result[key] = templateId;
  }
  return result;
}

export function registerSyncTools(server: McpServer, client: SendGridClient) {
  ensureSafeToolRegistration(server);
  server.registerTool(
    'sync_template_ids',
    {
      description: [
        'Read a TypeScript/JavaScript file containing a SENDGRID_TEMPLATES object and compare it with real templates in SendGrid.',
        'Reports: which IDs are placeholder (d-xxx), which do not exist in SendGrid, and which are real.',
        'This is an opt-in local sync helper; provide constantsPath explicitly.',
      ].join(' '),
      inputSchema: z.object({
        constantsPath: ConstantsPathSchema,
      }),
      outputSchema: SyncTemplateIdsOutputSchema,
    },
    async ({ constantsPath }) => {
      const filePath = constantsPath;
      const file = Bun.file(filePath);

      if (!(await file.exists())) {
        throw new Error(`File not found: ${filePath}`);
      }

      const source = await file.text();
      const localMap = parseTemplatesFromSource(source);

      if (Object.keys(localMap).length === 0) {
        throw new Error(`Could not parse SENDGRID_TEMPLATES from ${filePath}`);
      }

      const sgTemplates = await client.listAllDynamicTemplates(200);
      const sgById = new Map(sgTemplates.map((t) => [t.id, t]));

      const placeholderPattern = /^d-[a-z]+-?[a-z]*$/;
      const isPlaceholder = (id: string) =>
        placeholderPattern.test(id) || id.length < 36;

      const rows: string[] = [];
      let missingCount = 0;
      let placeholderCount = 0;
      let okCount = 0;

      for (const [key, id] of Object.entries(localMap)) {
        if (isPlaceholder(id)) {
          rows.push(`PLACEHOLDER  '${key}': '${id}'`);
          placeholderCount++;
          continue;
        }

        const sgTemplate = sgById.get(id);
        if (!sgTemplate) {
          rows.push(
            `NOT IN SENDGRID  '${key}': '${id}'  (ID not found in your SendGrid account)`,
          );
          missingCount++;
        } else {
          const active = sgTemplate.versions.find((v) => v.active === 1);
          rows.push(
            `OK  '${key}': '${id}' -> "${sgTemplate.name}" (active: "${active?.subject ?? 'none'}")`,
          );
          okCount++;
        }
      }

      const localIds = new Set(Object.values(localMap));
      const unreferencedTemplateIds = sgTemplates
        .filter((t) => !localIds.has(t.id))
        .map((t) => `${t.id} "${t.name}"`);

      const structured = {
        filePath,
        okCount,
        placeholderCount,
        missingCount,
        rows,
        unreferencedTemplateIds,
      };

      const summary = [
        `File: ${filePath}`,
        ``,
        `Summary: ${okCount} ok | ${placeholderCount} placeholder | ${missingCount} id-not-found`,
        ``,
        ...rows,
      ];

      if (unreferencedTemplateIds.length > 0) {
        summary.push(``, `Templates in SendGrid not referenced in constants`);
        for (const entry of unreferencedTemplateIds) {
          summary.push(`  [${entry}]`);
        }
      }

      return jsonReadResult(structured, summary.join('\n'));
    },
  );
}
