import { AsyncLocalStorage } from 'node:async_hooks';

const toolAbortSignal = new AsyncLocalStorage<AbortSignal>();

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
