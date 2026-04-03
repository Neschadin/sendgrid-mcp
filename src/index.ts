#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { version } from '../package.json';
import { SendGridClient } from './client';
import { registerDiagnosticsTools } from './tools/diagnostics';
import { registerEmailTools } from './tools/email';
import { registerPreflightTools } from './tools/preflight';
import { registerSyncTools } from './tools/sync';
import { registerTemplateTools } from './tools/templates';
import { startWebhookReceiverFromEnv } from './webhook_receiver';

const REQUIRED_ENV = ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'] as const;

function getEnv(): {
  apiKey: string;
  fromEmail: string;
  fromName: string;
} {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      process.stderr.write(`[sendgrid-mcp] Missing required env var: ${key}\n`);
      process.exit(1);
    }
  }
  return {
    apiKey: process.env['SENDGRID_API_KEY']!,
    fromEmail: process.env['SENDGRID_FROM_EMAIL']!,
    fromName: process.env['SENDGRID_FROM_NAME'] ?? 'Kennitalan',
  };
}

async function main() {
  const env = getEnv();
  startWebhookReceiverFromEnv();
  const client = new SendGridClient(env.apiKey);

  const server = new McpServer({
    name: 'sendgrid',
    version,
  });

  registerTemplateTools(server, client);
  registerEmailTools(server, client, env.fromEmail, env.fromName);
  registerPreflightTools(server, client);
  registerDiagnosticsTools(server, client);
  registerSyncTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[sendgrid-mcp] Server started\n');
}

main().catch((err) => {
  process.stderr.write(`[sendgrid-mcp] Fatal: ${String(err)}\n`);
  process.exit(1);
});
