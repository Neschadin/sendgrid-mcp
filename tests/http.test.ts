import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/server';
import { createHttpFetch } from '../src/http';
import type { HttpEndpointConfig } from '../src/config';

const http: HttpEndpointConfig = {
  host: '127.0.0.1',
  port: 3000,
  authMode: 'token',
  authToken: 'test-token',
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: ['127.0.0.1'],
  trustProxy: false,
};

function endpoint() {
  return createHttpFetch({
    http,
    factory: () => new McpServer({ name: 'sendgrid-http-test', version: '0.0.0' }),
  });
}

describe('HTTP MCP', () => {
  test('health is open and /mcp requires the bearer token', async () => {
    const app = endpoint();
    const health = await app.fetch(
      new Request('http://127.0.0.1/health', {
        headers: { host: '127.0.0.1' },
      }),
    );
    expect(health.status).toBe(200);

    const denied = await app.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(denied.status).toBe(401);

    const accepted = await app.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'http-test', version: '0.0.0' },
          },
        }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('sendgrid-http-test');
    await app.close();
  });
});
