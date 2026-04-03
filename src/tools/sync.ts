import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SendGridClient } from '../client';

const DEFAULT_CONSTANTS_PATH =
  '/Users/oleksandrn/P/Kennitalan-BE/src/notifications/notifications.constants.ts';

/**
 * Parse SENDGRID_TEMPLATES object from the source file.
 * Returns a map of eventKey → templateId.
 */
function parseTemplatesFromSource(source: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Match the SENDGRID_TEMPLATES = { ... } block
  const blockMatch = source.match(/SENDGRID_TEMPLATES\s*=\s*\{([^}]+)\}/s);
  if (!blockMatch) return result;

  const block = blockMatch[1];
  if (!block) return result;
  // Each line: 'key': 'd-xxxx',  or  key: 'd-xxxx',
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
  server.registerTool(
    'sync_template_ids',
    {
      description: [
        'Read SENDGRID_TEMPLATES from notifications.constants.ts and compare with real templates in SendGrid.',
        'Reports: which IDs are placeholder (d-xxx), which do not exist in SendGrid, and which are real.',
        'Optionally provide a custom path to the constants file.',
      ].join(' '),
      inputSchema: z.object({
        constantsPath: z
          .string()
          .optional()
          .describe(
            `Absolute path to notifications.constants.ts (default: ${DEFAULT_CONSTANTS_PATH})`,
          ),
      }),
    },
    async ({ constantsPath }) => {
      const filePath = constantsPath ?? DEFAULT_CONSTANTS_PATH;
      const file = Bun.file(filePath);

      if (!(await file.exists())) {
        return {
          content: [{ type: 'text', text: `❌ File not found: ${filePath}` }],
        };
      }

      const source = await file.text();
      const localMap = parseTemplatesFromSource(source);

      if (Object.keys(localMap).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Could not parse SENDGRID_TEMPLATES from ${filePath}`,
            },
          ],
        };
      }

      // Fetch real templates from SendGrid
      const { result: sgTemplates } = await client.listTemplates();
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
          rows.push(`🔴 PLACEHOLDER  '${key}': '${id}'`);
          placeholderCount++;
          continue;
        }

        const sgTemplate = sgById.get(id);
        if (!sgTemplate) {
          rows.push(
            `🟡 NOT IN SG    '${key}': '${id}'  (ID not found in your SendGrid account)`,
          );
          missingCount++;
        } else {
          const active = sgTemplate.versions.find((v) => v.active === 1);
          rows.push(
            `✅ OK           '${key}': '${id}'  → "${sgTemplate.name}" (active: "${active?.subject ?? '—'}")`,
          );
          okCount++;
        }
      }

      // Show SG templates not referenced in constants
      const localIds = new Set(Object.values(localMap));
      const unreferenced = sgTemplates.filter((t) => !localIds.has(t.id));

      const summary = [
        `File: ${filePath}`,
        ``,
        `Summary: ${okCount} ✅ ok  |  ${placeholderCount} 🔴 placeholder  |  ${missingCount} 🟡 id-not-found`,
        ``,
        ...rows,
      ];

      if (unreferenced.length > 0) {
        summary.push(
          ``,
          `── Templates in SendGrid not referenced in constants ──`,
        );
        for (const t of unreferenced) {
          summary.push(`  [${t.id}] "${t.name}"`);
        }
      }

      return { content: [{ type: 'text', text: summary.join('\n') }] };
    },
  );
}
