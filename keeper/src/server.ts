/** Tiny operational HTTP surface: `/healthz` and `/metrics`. No framework, no dependencies. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HealthReport } from './health.js';
import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';

export interface ServerDeps {
  port: number;
  host: string;
  metrics: MetricsRegistry;
  health: () => HealthReport;
  logger: Logger;
  version: string;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** Exported for tests: routing and status selection with no socket involved. */
export function handleRequest(
  url: string,
  deps: Pick<ServerDeps, 'metrics' | 'health' | 'version'>,
): { status: number; contentType: string; body: string } {
  const path = url.split('?')[0] ?? '/';
  switch (path) {
    case '/healthz':
    case '/health': {
      const report = deps.health();
      return {
        status: report.healthy ? 200 : 503,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(report, null, 2),
      };
    }
    case '/metrics':
      return {
        status: 200,
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        body: deps.metrics.render(),
      };
    case '/':
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ service: 'updown-keeper', version: deps.version, endpoints: ['/healthz', '/metrics'] }),
      };
    default:
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found\n' };
  }
}

export async function startServer(deps: ServerDeps): Promise<RunningServer | null> {
  if (deps.port === 0) {
    deps.logger.warn('METRICS_PORT=0; the health and metrics endpoints are disabled');
    return null;
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let result: { status: number; contentType: string; body: string };
    try {
      result = handleRequest(req.url ?? '/', deps);
    } catch (error) {
      deps.logger.error('metrics server handler threw', { error });
      result = { status: 500, contentType: 'text/plain; charset=utf-8', body: 'internal error\n' };
    }
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(result.body),
    });
    res.end(req.method === 'HEAD' ? undefined : result.body);
  });

  server.on('error', (error) => {
    deps.logger.error('metrics server error', { error });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(deps.port, deps.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : deps.port;
  deps.logger.info('metrics server listening', { host: deps.host, port, endpoints: ['/healthz', '/metrics'] });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
