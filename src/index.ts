#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { version } from '../package.json';
import { logError, logInfo } from './logger';
import { SendGridClient } from './client';
import { registerDiagnosticsTools } from './tools/diagnostics';
import { registerEmailTools } from './tools/email';
import { registerPreflightTools } from './tools/preflight';
import { registerSyncTools } from './tools/sync';
import { registerTemplateTools } from './tools/templates';
import {
  startWebhookReceiverFromEnv,
  stopWebhookReceiver,
} from './webhook_receiver';

const REQUIRED_ENV = ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'] as const;

function getEnv(): {
  apiKey: string;
  fromEmail: string;
  fromName: string;
} {
  const env = Bun.env;

  for (const key of REQUIRED_ENV) {
    if (!env[key]) {
      logError(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }
  return {
    apiKey: env['SENDGRID_API_KEY']!,
    fromEmail: env['SENDGRID_FROM_EMAIL']!,
    fromName: env['SENDGRID_FROM_NAME'] ?? 'Kennitalan',
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
  (transport as { onclose?: () => void }).onclose = () => {
    logInfo('Transport closed');
    stopWebhookReceiver();
  };
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Shutdown requested (${signal})`);
    stopWebhookReceiver();
    try {
      await (transport as { close?: () => Promise<void> | void }).close?.();
      await (server as { close?: () => Promise<void> | void }).close?.();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.connect(transport);

  logInfo('Server started');
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  stopWebhookReceiver();
  process.exit(1);
});
