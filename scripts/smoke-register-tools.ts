import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SendGridClient } from '../src/client';
import { registerAccountTools } from '../src/tools/account';
import { registerConsoleSettingsTools } from '../src/tools/console_settings';
import { registerDiagnosticsTools } from '../src/tools/diagnostics';
import { registerEmailTools } from '../src/tools/email';
import { registerPreflightTools } from '../src/tools/preflight';
import { registerSyncTools } from '../src/tools/sync';
import { registerTemplateTools } from '../src/tools/templates';
import {
  getRegisteredToolCount,
  getRegisteredToolNames,
  TOOL_NAME_PREFIX,
} from '../src/tools/tool_utils';

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
  name: 'sendgrid-mcp-server',
  version: '0.0.0',
});

registerTemplateTools(server, client);
registerEmailTools(server, client, 'sender@example.com', 'SendGrid MCP');
registerPreflightTools(server, client);
registerDiagnosticsTools(server, client);
registerSyncTools(server, client);
registerAccountTools(server, client);
registerConsoleSettingsTools(server, client);

const count = getRegisteredToolCount();
const names = getRegisteredToolNames();

if (count < 60) {
  throw new Error(`Expected at least 60 registered tools, got ${count}`);
}

for (const name of names) {
  if (!name.startsWith(TOOL_NAME_PREFIX)) {
    throw new Error(`Tool "${name}" is missing required prefix "${TOOL_NAME_PREFIX}"`);
  }
}

process.stdout.write(
  `Tool registration smoke test passed (${count} tools, all prefixed).\n`,
);
