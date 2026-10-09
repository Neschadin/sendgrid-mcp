#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { version } from '../package.json';
import { SendGridClient } from './client';
import {
  buildServerInstructions,
  loadConfig,
  MAX_TOOL_INPUT_ELEMENTS,
} from './config';
import { startHttpServer } from './http';
import { logError, logInfo, logWarn } from './logger';
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

function buildServer(
  client: SendGridClient,
  fromEmail: string,
  fromName: string,
  instructions: string,
): McpServer {
  const server = new McpServer(
    {
      name: 'sendgrid-mcp-server',
      version,
    },
    {
      instructions,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );

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
  const env = loadConfig();
  if (!env.apiKey.startsWith('SG.')) {
    logWarn('SENDGRID_API_KEY does not start with SG.');
  }
  try {
    startWebhookReceiverFromEnv();
  } catch (error) {
    logWarn(`Webhook receiver not started: ${String(error)}`);
  }
  const client = new SendGridClient(env.apiKey, env.apiBaseUrl, {
    onBehalfOf: env.onBehalfOf,
    preferEmailLogs: env.preferEmailLogs,
  });
  const instructions = buildServerInstructions(env);
  const factory = () =>
    buildServer(client, env.fromEmail, env.fromName, instructions);

  if (env.transport === 'http' && env.http) {
    const endpoint = startHttpServer({ factory, http: env.http });
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logInfo(`Shutdown requested (${signal})`);
      try {
        await endpoint.stop();
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
    return;
  }

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

  const handle = serveStdio(factory,
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
