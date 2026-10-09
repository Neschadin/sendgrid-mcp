import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isSendGridApiError } from '../client';
import { redactToolResult } from '../redact';
import {
  abortSignalFromExtra,
  onBehalfOfFromArgs,
  runWithOnBehalfOf,
  runWithToolAbortSignal,
} from '../tool_signal';

export const OnBehalfOfSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Subuser username, "account-id <id>", or "parent" to ignore SENDGRID_ON_BEHALF_OF for this call. Added to every tool.',
  );

export const TOOL_NAME_PREFIX = 'sendgrid_';
export const CONFIRM_TOKEN_SUFFIX = ' Requires confirmToken="CONFIRM".';
export const SEND_PREFLIGHT_HINT =
  ' Run validate_send_request first unless using send_with_preflight.';

export const ResponseFormatSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe(
    'markdown for human-readable text; json for machine-readable text content',
  );

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const ListPagingInputFields = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum items to return (default 50)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of items to skip (default 0)'),
  response_format: ResponseFormatSchema.optional(),
};

export const ReadInputFields = {
  response_format: ResponseFormatSchema.optional(),
};

const LOCAL_TOOL_NAMES = new Set([
  'classify_sendgrid_error',
  'clear_received_webhook_events',
  'get_received_webhook_events',
  'get_webhook_receiver_status',
]);

export function isReadOnlyMode(): boolean {
  const raw = Bun.env['READ_ONLY']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function bareToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX)
    ? name.slice(TOOL_NAME_PREFIX.length)
    : name;
}

export function prefixedToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name : `${TOOL_NAME_PREFIX}${name}`;
}

function inputSchemaRequiresConfirm(inputSchema: unknown): boolean {
  if (!(inputSchema instanceof z.ZodObject)) return false;

  const field = inputSchema.shape['confirmToken'];
  if (!field) return false;
  if (field instanceof z.ZodOptional) return false;

  return true;
}

function augmentDescription(
  description: string | undefined,
  requiresConfirm: boolean,
): string | undefined {
  if (!description) return description;
  let next = description.trim();
  if (requiresConfirm && !next.includes('confirmToken="CONFIRM"')) {
    next += CONFIRM_TOKEN_SUFFIX;
  }
  return next;
}

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
        'Check API key scopes for this endpoint and whether the account/plan can access it. Call sendgrid_get_scopes to list scopes on this key.',
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

  if (error instanceof Error && error.name === 'AbortError') {
    return 'SendGrid request cancelled because the MCP client aborted the tool call.';
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

const SAFE_TOOL_PATCHED = Symbol('safe-tool-patched');
let registeredToolCount = 0;
const registeredToolNames: string[] = [];

export function getRegisteredToolNames(): readonly string[] {
  return registeredToolNames;
}

export function getRegisteredToolCount(): number {
  return registeredToolCount;
}

function titleFromName(name: string): string {
  return bareToolName(name)
    .split('_')
    .filter(Boolean)
    .map((chunk) => chunk[0]?.toUpperCase() + chunk.slice(1))
    .join(' ');
}

function inferAnnotations(
  name: string,
  config: Record<string, unknown>,
): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const explicit = config['annotations'];
  if (
    explicit &&
    typeof explicit === 'object' &&
    'readOnlyHint' in explicit &&
    typeof explicit.readOnlyHint === 'boolean'
  ) {
    return {
      readOnlyHint: explicit.readOnlyHint,
      destructiveHint:
        'destructiveHint' in explicit &&
        typeof explicit.destructiveHint === 'boolean'
          ? explicit.destructiveHint
          : false,
      idempotentHint:
        'idempotentHint' in explicit &&
        typeof explicit.idempotentHint === 'boolean'
          ? explicit.idempotentHint
          : explicit.readOnlyHint,
      openWorldHint:
        'openWorldHint' in explicit && typeof explicit.openWorldHint === 'boolean'
          ? explicit.openWorldHint
          : true,
    };
  }

  const bare = bareToolName(name);
  const mutatingPrefixes = [
    'activate_',
    'cancel_',
    'clear_',
    'create_',
    'delete_',
    'pause_',
    'prune_',
    'rename_',
    'resend_',
    'resume_',
    'schedule_',
    'send_',
    'toggle_',
    'manage_',
    'update_',
    'validate_authenticated_',
    'validate_branded_',
  ];
  const destructivePrefixes = [
    'cancel_',
    'clear_',
    'delete_',
    'manage_',
    'prune_',
  ];
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

  const mutating = mutatingPrefixes.some((prefix) => bare.startsWith(prefix));
  const destructive = destructivePrefixes.some((prefix) =>
    bare.startsWith(prefix),
  );
  const readOnly =
    !mutating && readOnlyPrefixes.some((prefix) => bare.startsWith(prefix));

  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive || bare === 'send_with_preflight',
    idempotentHint: readOnly,
    openWorldHint: !LOCAL_TOOL_NAMES.has(bare),
  };
}

export function isReadOnlyBlocked(toolName: string): boolean {
  if (!isReadOnlyMode()) return false;
  return inferAnnotations(toolName, {}).readOnlyHint !== true;
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
  ) => {
    const exposedName =
      typeof name === 'string' ? prefixedToolName(name) : name;

    if (typeof exposedName === 'string') {
      registeredToolCount += 1;
      registeredToolNames.push(exposedName);
    }

    return (rawRegisterTool as (n: unknown, c: unknown, h: ToolHandler) => void)(
      exposedName,
      typeof name === 'string' && typeof config === 'object' && config !== null
        ? (() => {
            const cfg = config as Record<string, unknown>;
            const inputSchema = cfg['inputSchema'];
            if (
              inputSchema instanceof z.ZodObject &&
              !('onBehalfOf' in inputSchema.shape)
            ) {
              cfg['inputSchema'] = inputSchema.extend({
                onBehalfOf: OnBehalfOfSchema,
              });
            }
            const requiresConfirm = inputSchemaRequiresConfirm(
              cfg['inputSchema'],
            );
            return {
              ...cfg,
              description: augmentDescription(
                typeof cfg['description'] === 'string'
                  ? cfg['description']
                  : undefined,
                requiresConfirm,
              ),
              title: cfg['title'] ?? titleFromName(name as string),
              annotations: inferAnnotations(name as string, cfg),
            };
          })()
        : config,
      async (args: unknown, extra: unknown) => {
        const signal = abortSignalFromExtra(extra);
        const onBehalfOf = onBehalfOfFromArgs(args);
        const run = async () => {
          try {
            if (
              typeof exposedName === 'string' &&
              isReadOnlyBlocked(exposedName)
            ) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `Blocked by READ_ONLY=true. ${exposedName} can send mail or change SendGrid. Set READ_ONLY=false to run it.`,
                  },
                ],
              };
            }
            return await handler(args, extra);
          } catch (error) {
            return {
              isError: true,
              content: [{ type: 'text', text: formatToolError(error) }],
            };
          }
        };

        const result = await runWithOnBehalfOf(onBehalfOf, () =>
          runWithToolAbortSignal(signal, run),
        );
        return redactToolResult(result);
      },
    );
  }) as typeof server.registerTool;

  (server as unknown as Record<symbol, boolean>)[SAFE_TOOL_PATCHED] = true;
}
