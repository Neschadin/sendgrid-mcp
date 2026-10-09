import {
  InMemoryTransport,
  McpServer,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
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

await assertLegacyHandshake(server, names);

process.stdout.write(
  `Tool registration smoke test passed (${count} tools, all prefixed).\n`,
);

async function assertLegacyHandshake(
  server: McpServer,
  expectedNames: readonly string[],
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: JSONRPCMessage) => void>();

  clientTransport.onmessage = (message) => {
    if (!('id' in message) || typeof message.id !== 'number') return;
    pending.get(message.id)?.(message);
  };

  await Promise.all([clientTransport.start(), server.connect(serverTransport)]);

  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      void clientTransport.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params ? { params } : {}),
      });
    });

  const init = await request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  if (!('result' in init) || init.result == null) {
    throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  }

  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  const listed: string[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    page += 1;
    const response = await request(
      page + 1,
      'tools/list',
      cursor ? { cursor } : {},
    );
    if (!('result' in response) || response.result == null) {
      throw new Error(`tools/list failed: ${JSON.stringify(response)}`);
    }
    const result = response.result as {
      tools?: Array<{ name?: string; inputSchema?: { type?: string } }>;
      nextCursor?: string;
    };
    for (const tool of result.tools ?? []) {
      if (!tool.name) throw new Error('tools/list returned a tool without a name');
      if (tool.inputSchema?.type !== 'object') {
        throw new Error(
          `Tool "${tool.name}" inputSchema did not convert to a JSON Schema object`,
        );
      }
      listed.push(tool.name);
    }
    cursor = result.nextCursor;
  } while (cursor);

  if (listed.length !== expectedNames.length) {
    throw new Error(
      `tools/list returned ${listed.length} tools, registration counted ${expectedNames.length}`,
    );
  }

  await clientTransport.close();
  await server.close();
}
