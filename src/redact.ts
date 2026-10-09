const SECRET_KEYS = new Set([
  'oauth_client_secret',
  'api_key',
  'apikey',
  'authorization',
  'password',
]);

const JSON_SECRET_STRING =
  /"(oauth_client_secret|api_key|apikey|authorization|password)"\s*:\s*("(?:\\.|[^"\\])*"|null)/gi;

export function formatRedactedSecret(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('<redacted')) {
    return value;
  }
  if (typeof value === 'string') {
    return `<redacted len=${value.length}>`;
  }
  if (value == null) return '<redacted>';
  return '<redacted>';
}

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = SECRET_KEYS.has(key.toLowerCase())
        ? formatRedactedSecret(nested)
        : redactSensitiveFields(nested);
    }
    return out;
  }

  return value;
}

export function redactSecretsInText(text: string): string {
  if (!JSON_SECRET_STRING.test(text)) {
    JSON_SECRET_STRING.lastIndex = 0;
    return text;
  }
  JSON_SECRET_STRING.lastIndex = 0;

  try {
    return JSON.stringify(redactSensitiveFields(JSON.parse(text)), null, 2);
  } catch {
    JSON_SECRET_STRING.lastIndex = 0;
    return text.replace(JSON_SECRET_STRING, (_match, key: string, raw: string) => {
      try {
        return `"${key}": ${JSON.stringify(formatRedactedSecret(JSON.parse(raw)))}`;
      } catch {
        return `"${key}": ${JSON.stringify(formatRedactedSecret(undefined))}`;
      }
    });
  }
}

export function redactToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record['content'])
    ? record['content'].map((block) => {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          return {
            ...(block as Record<string, unknown>),
            text: redactSecretsInText((block as { text: string }).text),
          };
        }
        return block;
      })
    : record['content'];

  return {
    ...record,
    ...(content !== undefined ? { content } : {}),
    ...(record['structuredContent'] !== undefined
      ? { structuredContent: redactSensitiveFields(record['structuredContent']) }
      : {}),
  };
}
