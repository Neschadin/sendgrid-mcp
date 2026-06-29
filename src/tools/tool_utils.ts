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
    const hints: string[] = [];
    if (error.status === 401) {
      hints.push('Check that SENDGRID_API_KEY is valid and has not been revoked.');
    }
    if (error.status === 403) {
      hints.push(
        'Check API key scopes for this endpoint and whether the account/plan can access it.',
      );
    }
    if (error.status === 404) {
      hints.push('Check the resource ID, endpoint region, and account/subuser context.');
    }
    if (error.status === 429) {
      hints.push('SendGrid rate-limited the request; retry later or reduce request rate.');
    }
    const hintText =
      hints.length > 0
        ? `\nNext steps:\n${hints.map((hint) => `- ${hint}`).join('\n')}`
        : '';
    return `SendGrid API error (${error.status}) on ${error.method} ${error.path}.${details}${hintText}`;
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

function inferAnnotations(name: string, config: Record<string, unknown>) {
  if (config['annotations'] !== undefined) return config['annotations'];

  const mutatingPrefixes = [
    'activate_',
    'cancel_',
    'clear_',
    'create_',
    'delete_',
    'pause_',
    'prune_',
    'rename_',
    'resume_',
    'schedule_',
    'send_',
    'toggle_',
    'update_',
  ];
  const destructivePrefixes = ['cancel_', 'clear_', 'delete_', 'prune_'];
  const readOnlyPrefixes = [
    'analyze_',
    'check_',
    'classify_',
    'get_',
    'list_',
    'search_',
    'sync_',
    'triage_',
    'validate_send_request',
  ];

  const mutating = mutatingPrefixes.some((prefix) => name.startsWith(prefix));
  const destructive = destructivePrefixes.some((prefix) =>
    name.startsWith(prefix),
  );
  const readOnly =
    !mutating && readOnlyPrefixes.some((prefix) => name.startsWith(prefix));

  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: true,
  };
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
            annotations: inferAnnotations(
              name,
              config as Record<string, unknown>,
            ),
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
