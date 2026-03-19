import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SendGridClient } from '../client';

export function registerDiagnosticsTools(
  server: McpServer,
  client: SendGridClient,
) {
  server.registerTool(
    'check_suppression',
    {
      description:
        'Check if an email address is suppressed (bounced / blocked / unsubscribed / spam reported)',
      inputSchema: z.object({
        email: z.string().email().describe('Email address to check'),
      }),
    },
    async ({ email }) => {
      const result = await client.checkSuppression(email);

      const flags = [
        result.bounced && '🔴 BOUNCED',
        result.blocked && '🔴 BLOCKED',
        result.unsubscribed && '🟡 UNSUBSCRIBED',
        result.spamReported && '🔴 SPAM REPORTED',
      ].filter(Boolean);

      const status =
        flags.length === 0 ? '✅ Clean — not suppressed' : flags.join('  ');

      const lines = [`Email: ${email}`, `Status: ${status}`, ``];

      const details = result.details as Record<string, unknown[]>;
      for (const [key, entries] of Object.entries(details)) {
        if (Array.isArray(entries) && entries.length > 0) {
          lines.push(`${key}: ${JSON.stringify(entries, null, 2)}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'get_email_stats',
    {
      description: 'Get global email delivery statistics for a date range',
      inputSchema: z.object({
        startDate: z.string().describe('Start date YYYY-MM-DD'),
        endDate: z
          .string()
          .optional()
          .describe('End date YYYY-MM-DD (defaults to today)'),
      }),
    },
    async ({ startDate, endDate }) => {
      const stats = await client.getStats(startDate, endDate);

      if (stats.length === 0) {
        return {
          content: [{ type: 'text', text: 'No stats for the given range.' }],
        };
      }

      const rows = stats.map((day) => {
        const m = day.stats[0]?.metrics;
        if (!m) return `${day.date}: no data`;
        const rate =
          m.requests > 0 ? ((m.delivered / m.requests) * 100).toFixed(1) : '—';
        return [
          `${day.date}`,
          `  requests=${m.requests}  delivered=${m.delivered} (${rate}%)`,
          `  bounces=${m.bounces}  spam=${m.spam_reports}  unsubs=${m.unsubscribes}`,
          `  opens=${m.opens}  clicks=${m.clicks}`,
        ].join('\n');
      });

      const total = stats.reduce(
        (acc, day) => {
          const m = day.stats[0]?.metrics;
          if (!m) return acc;
          acc.requests += m.requests;
          acc.delivered += m.delivered;
          acc.bounces += m.bounces;
          acc.opens += m.opens;
          return acc;
        },
        { requests: 0, delivered: 0, bounces: 0, opens: 0 },
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Stats: ${startDate} → ${endDate ?? 'today'}`,
              `Total: ${total.requests} requests, ${total.delivered} delivered, ${total.bounces} bounces, ${total.opens} opens`,
              ``,
              ...rows,
            ].join('\n'),
          },
        ],
      };
    },
  );
}
