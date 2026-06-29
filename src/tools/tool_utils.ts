import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isSendGridApiError } from '../client';

type ToolHandler = (
  args: unknown,
  extra: unknown,
) => Promise<unknown> | unknown;

/** Normalizes tool/runtime errors into a single user-facing string (MCP `content[].text`). */
export function formatToolError(error: unknown): string {
  if (isSendGridApiError(error)) {
    const details =
      error.errors.length > 0
        ? `\n${error.errors.map((entry) => `- ${entry.message}`).join('\n')}`
        : '';
    return `SendGrid API error (${error.status}) on ${error.method} ${error.path}.${details}`;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

const SAFE_TOOL_PATCHED = Symbol('safe-tool-patched');

function titleFromName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((chunk) => chunk[0]?.toUpperCase() + chunk.slice(1))
    .join(' ');
}

export function ensureSafeToolRegistration(server: McpServer) {
  const marker = (server as unknown as Record<symbol, boolean>)[
    SAFE_TOOL_PATCHED
  ];
  if (marker) return;

  const rawRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: unknown,
    config: unknown,
    handler: ToolHandler,
  ) =>
    (rawRegisterTool as (n: unknown, c: unknown, h: ToolHandler) => void)(
      name,
      typeof name === 'string' && typeof config === 'object' && config !== null
        ? {
            ...(config as Record<string, unknown>),
            title:
              (config as Record<string, unknown>)['title'] ??
              titleFromName(name),
          }
        : config,
      async (args: unknown, extra: unknown) => {
        try {
          return await handler(args, extra);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: formatToolError(error) }],
          };
        }
      },
    )) as typeof server.registerTool;

  (server as unknown as Record<symbol, boolean>)[SAFE_TOOL_PATCHED] = true;
}
