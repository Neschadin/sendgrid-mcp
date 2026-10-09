import { AsyncLocalStorage } from 'node:async_hooks';

const toolAbortSignal = new AsyncLocalStorage<AbortSignal>();
const onBehalfOfStore = new AsyncLocalStorage<string>();

/** Call the parent account even when SENDGRID_ON_BEHALF_OF is set. */
export const PARENT_ACCOUNT = 'parent';

export function currentOnBehalfOf(): string | undefined {
  return onBehalfOfStore.getStore();
}

export function resolveOnBehalfOfHeader(
  override: string | undefined,
  configured: string | undefined,
): string | undefined {
  if (override === PARENT_ACCOUNT) return undefined;
  return override ?? configured;
}

export function runWithOnBehalfOf<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (value === undefined) return run();
  return onBehalfOfStore.run(value, run);
}

export function onBehalfOfFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as { onBehalfOf?: unknown }).onBehalfOf;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function currentToolAbortSignal(): AbortSignal | undefined {
  return toolAbortSignal.getStore();
}

export function runWithToolAbortSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return signal ? toolAbortSignal.run(signal, run) : run();
}

export function abortSignalFromExtra(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const signal = (extra as { mcpReq?: { signal?: unknown } }).mcpReq?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
