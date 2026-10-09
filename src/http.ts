import { timingSafeEqual } from 'node:crypto';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type AuthInfo,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { HttpEndpointConfig } from './config';
import { logError, logInfo } from './logger';

function tokenEquals(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeBearer(
  request: Request,
  expectedToken: string,
): AuthInfo | Response {
  const header = request.headers.get('authorization');
  const presented = header?.match(/^Bearer\s+(\S+)\s*$/iu)?.[1];
  if (!presented || !tokenEquals(presented, expectedToken)) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
        'cache-control': 'no-store',
      },
    });
  }

  return {
    token: presented,
    clientId: 'static-token',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

export function createHttpFetch(options: {
  factory: () => McpServer;
  http: HttpEndpointConfig;
  onerror?: (error: Error) => void;
}): {
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
} {
  const handler = createMcpHandler(options.factory, {
    legacy: 'stateless',
    onerror: options.onerror,
  });
  const hosts =
    options.http.allowedHosts.length > 0
      ? options.http.allowedHosts
      : localhostAllowedHostnames();
  const origins =
    options.http.allowedOrigins.length > 0
      ? options.http.allowedOrigins
      : localhostAllowedOrigins();

  return {
    close: () => handler.close(),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (
        request.method === 'GET' &&
        (url.pathname === '/health' || url.pathname === '/health/')
      ) {
        return Response.json({ status: 'ok' });
      }
      if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') {
        return new Response('Not found', { status: 404 });
      }

      const rejected =
        hostHeaderValidationResponse(request, hosts) ??
        originValidationResponse(request, origins);
      if (rejected) return rejected;

      let authInfo: AuthInfo | undefined;
      if (options.http.authMode === 'token') {
        const auth = authorizeBearer(request, options.http.authToken ?? '');
        if (auth instanceof Response) return auth;
        authInfo = auth;
      }

      return handler.fetch(request, authInfo ? { authInfo } : undefined);
    },
  };
}

export function startHttpServer(options: {
  factory: () => McpServer;
  http: HttpEndpointConfig;
}): { url: string; stop: () => Promise<void> } {
  const endpoint = createHttpFetch({
    factory: options.factory,
    http: options.http,
    onerror: (error) => {
      logError(`MCP HTTP error: ${error.message}`);
    },
  });
  const tls =
    options.http.tlsKeyFile && options.http.tlsCertFile
      ? {
          key: Bun.file(options.http.tlsKeyFile),
          cert: Bun.file(options.http.tlsCertFile),
        }
      : undefined;
  const server = Bun.serve({
    hostname: options.http.host,
    port: options.http.port,
    fetch: endpoint.fetch,
    ...(tls ? { tls } : {}),
  });
  const scheme = tls ? 'https' : 'http';
  const url = `${scheme}://${server.hostname ?? options.http.host}:${server.port}/mcp`;
  logInfo(`HTTP MCP listening on ${url}`);

  return {
    url,
    stop: async () => {
      await endpoint.close();
      await server.stop(true);
    },
  };
}
