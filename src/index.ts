#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { version } from '../package.json';
import { logError, logInfo, logWarn } from './logger';
import { SendGridClient } from './client';
import { registerDiagnosticsTools } from './tools/diagnostics';
import { registerEmailTools } from './tools/email';
import { registerPreflightTools } from './tools/preflight';
import { registerSyncTools } from './tools/sync';
import { registerTemplateTools } from './tools/templates';
import { registerAccountTools } from './tools/account';
import { registerConsoleSettingsTools } from './tools/console_settings';
import {
  startWebhookReceiverFromEnv,
  stopWebhookReceiver,
} from './webhook_receiver';

const REQUIRED_ENV = ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'] as const;

function getEnv(): {
  apiKey: string;
  apiBaseUrl: string;
  fromEmail: string;
  fromName: string;
  onBehalfOf?: string;
  preferEmailLogs: boolean;
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
    apiBaseUrl:
      env['SENDGRID_API_BASE_URL'] ??
      (env['SENDGRID_REGION'] === 'eu'
        ? 'https://api.eu.sendgrid.com/v3'
        : 'https://api.sendgrid.com/v3'),
    fromEmail: env['SENDGRID_FROM_EMAIL']!,
    fromName: env['SENDGRID_FROM_NAME'] ?? 'SendGrid MCP',
    onBehalfOf: env['SENDGRID_ON_BEHALF_OF'],
    preferEmailLogs: env['SENDGRID_REGION'] === 'eu',
  };
}

function buildServer(
  client: SendGridClient,
  fromEmail: string,
  fromName: string,
): McpServer {
  const server = new McpServer({
    name: 'sendgrid-mcp-server',
    version,
  });

  registerTemplateTools(server, client);
  registerEmailTools(server, client, fromEmail, fromName);
  registerPreflightTools(server, client);
  registerDiagnosticsTools(server, client);
  registerSyncTools(server, client);
  registerAccountTools(server, client);
  registerConsoleSettingsTools(server, client);

  return server;
}

async function main() {
  const env = getEnv();
  try {
    startWebhookReceiverFromEnv();
  } catch (error) {
    logWarn(`Webhook receiver not started: ${String(error)}`);
  }
  const client = new SendGridClient(env.apiKey, env.apiBaseUrl, {
    onBehalfOf: env.onBehalfOf,
    preferEmailLogs: env.preferEmailLogs,
  });

  // serveStdio owns onclose. Wrap close so the webhook listener (a keep-alive
  // handle) is released when stdin ends or the process is signalled.
  const transport = new StdioServerTransport();
  const closeTransport = transport.close.bind(transport);
  transport.close = async () => {
    try {
      await closeTransport();
    } finally {
      logInfo('Transport closed');
      stopWebhookReceiver();
    }
  };

  const handle = serveStdio(
    () => buildServer(client, env.fromEmail, env.fromName),
    {
      transport,
      onerror: (error) => {
        logError(`MCP transport error: ${error.message}`);
      },
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Shutdown requested (${signal})`);
    try {
      await handle.close();
    } finally {
      stopWebhookReceiver();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logInfo('Server started');
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  stopWebhookReceiver();
  process.exit(1);
});
