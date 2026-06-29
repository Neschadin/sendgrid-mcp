import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SendGridClient } from '../src/client';
import { registerAccountTools } from '../src/tools/account';
import { registerConsoleSettingsTools } from '../src/tools/console_settings';
import { registerDiagnosticsTools } from '../src/tools/diagnostics';
import { registerEmailTools } from '../src/tools/email';
import { registerPreflightTools } from '../src/tools/preflight';
import { registerSyncTools } from '../src/tools/sync';
import { registerTemplateTools } from '../src/tools/templates';

const client = new Proxy(
  {},
  {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      return () => {
        throw new Error(
          `Smoke test should only register tools; unexpected client call: ${property}`,
        );
      };
    },
  },
) as SendGridClient;

const server = new McpServer({
  name: 'sendgrid-smoke',
  version: '0.0.0',
});

registerTemplateTools(server, client);
registerEmailTools(server, client, 'sender@example.com', 'SendGrid MCP');
registerPreflightTools(server, client);
registerDiagnosticsTools(server, client);
registerSyncTools(server, client);
registerAccountTools(server, client);
registerConsoleSettingsTools(server, client);

process.stdout.write('Tool registration smoke test passed.\n');
