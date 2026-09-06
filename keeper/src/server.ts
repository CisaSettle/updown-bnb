/**
 * Tiny operational HTTP surface: `/healthz`, `/metrics`, and — only when the operator switches it
 * on — `POST /client-error`. No framework, no dependencies.
 *
 * The POST route is the only thing this process ever accepts input on, and it runs beside the
 * keeper's signing key, so it is deliberately the smallest surface that can do the job: a size cap
 * enforced WHILE STREAMING (buffering first and checking afterwards is the memory-exhaustion bug
 * the cap exists to prevent), a fixed schema, no disk, no credential, and the same 204 whatever it
 * decides, so a caller learns nothing from the answer.
 */

import { chmodSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { ClientErrorSink } from './clientErrors.js';
import type { HealthReport } from './health.js';
import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';

/**
 * Most bytes a report body may be. A signature and a count; anything larger is not a report from
 * our own page, and reading it would be doing an unauthenticated caller's work for them.
 */
export const MAX_REPORT_BYTES = 2048;

export interface ServerDeps {
  port: number;
  host: string;
  metrics: MetricsRegistry;
  health: () => HealthReport;
  logger: Logger;
  version: string;
  /** Absent when `CLIENT_ERROR_REPORTS` is off, and then `/client-error` 404s like any other path. */
  clientErrors?: ClientErrorSink;
  /** Injected so the rolling-window ceiling is testable without a fake clock. */
  now?: () => number;
  /**
   * An additional unix socket to serve the same routes on, alongside the TCP listener.
   *
   * This is how the TLS front reaches the report route without anything new appearing on a network
   * interface. On the production host `METRICS_HOST` is deliberately `127.0.0.1` and ufw denies
   * incoming on the docker bridges, so a container cannot reach this process over TCP at all — and
   * the fixes for that (binding every interface, opening a firewall rule) would both widen the
   * surface of the process that holds the signing key, to expose a side-channel for error reports.
   * A socket file needs neither: access is the file's own permissions, and `/metrics` becomes
   * reachable to exactly whatever can open that path and nothing else.
   *
   * The TCP listener is kept as it was, because the watchdog polls `http://127.0.0.1:9464/healthz`.
   */
  socketPath?: string;
}

/** What the transport managed to read off the request, for the routes that need more than a URL. */
export interface RequestFacts {
  method?: string;
  body?: string;
  origin?: string;
  /** True when the body hit `MAX_REPORT_BYTES` and was cut off. Counted as malformed. */
  truncated?: boolean;
}

export interface RunningServer {
  port: number;
  /** The socket actually being served, or null when none was configured. */
  socketPath: string | null;
  close: () => Promise<void>;
}

/** Permissions on the socket file. Owner and group only: it is the whole access-control story. */
const SOCKET_MODE = 0o660;

/** Exported for tests: routing and status selection with no socket involved. */
export function handleRequest(
  url: string,
  deps: Pick<ServerDeps, 'metrics' | 'health' | 'version' | 'clientErrors' | 'now'>,
  request: RequestFacts = {},
): { status: number; contentType: string; body: string } {
  const path = url.split('?')[0] ?? '/';
  switch (path) {
    case '/client-error': {
      // Off is indistinguishable from absent: an operator who has not enabled this should not be
      // advertising a route, and a scanner should not learn the keeper is an UpDown keeper here.
      if (!deps.clientErrors) break;
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        return { status: 405, contentType: 'text/plain; charset=utf-8', body: 'method not allowed\n' };
      }
      // Recorded for its outcome only. The answer never varies: telling an unauthenticated caller
      // whether their report was accepted, refused as malformed, or dropped by the ceiling is
      // telling them how to tune a flood.
      const body = request.truncated ? '' : (request.body ?? '');
      deps.clientErrors.record(body, request.origin, deps.now?.() ?? Date.now());
      return { status: 204, contentType: 'text/plain; charset=utf-8', body: '' };
    }
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
        body: JSON.stringify({
          service: 'updown-keeper',
          version: deps.version,
          endpoints: deps.clientErrors ? ['/healthz', '/metrics', '/client-error'] : ['/healthz', '/metrics'],
        }),
      };
    default:
      break;
  }
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found\n' };
}

/**
 * Read at most `MAX_REPORT_BYTES` off a request, destroying the connection the moment it overruns.
 *
 * The cap has to be enforced on the way in. Collecting an unbounded body and measuring it
 * afterwards is precisely the memory exhaustion this guards against, and this endpoint is
 * unauthenticated.
 */
export function readCappedBody(req: IncomingMessage, max = MAX_REPORT_BYTES): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean): void => {
      if (done) return;
      done = true;
      resolve({ body: truncated ? '' : Buffer.concat(chunks).toString('utf8'), truncated });
    };
    req.on('data', (chunk: unknown) => {
      // Normalised rather than assumed: a stream with an encoding set emits strings, and measuring
      // a string's `.length` counts characters, not bytes — which would let a multi-byte body
      // through at several times the cap it is supposed to enforce.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buffer.length;
      if (size > max) {
        req.destroy();
        finish(true);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish(false));
    req.on('error', () => finish(true));
    req.on('aborted', () => finish(true));
  });
}

/** The request handling every listener shares, so a socket and a port cannot drift apart. */
function createHandler(deps: ServerDeps): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let result: { status: number; contentType: string; body: string };
      try {
        // Only the report route reads a body, and only it pays for reading one.
        const wantsBody = deps.clientErrors !== undefined && req.method === 'POST';
        const read = wantsBody ? await readCappedBody(req) : { body: '', truncated: false };
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        result = handleRequest(req.url ?? '/', deps, { method: req.method, origin, ...read });
      } catch (error) {
        deps.logger.error('metrics server handler threw', { error });
        result = { status: 500, contentType: 'text/plain; charset=utf-8', body: 'internal error\n' };
      }
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(result.status, {
        'content-type': result.contentType,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(result.body),
      });
      res.end(req.method === 'HEAD' ? undefined : result.body);
    })();
  };
}

/**
 * Listen on a unix socket, and make sure a previous process's socket file cannot stop us.
 *
 * A socket file outlives a hard kill — `close()` unlinks it, `SIGKILL` and a panic do not — and the
 * leftover makes `listen` fail with EADDRINUSE for ever after. Removing a stale path first is what
 * keeps a crash from turning into a keeper that will not start until someone deletes a file by hand.
 * It is safe because two keepers on one socket path is already a misconfiguration, and the TCP
 * listener (which the watchdog polls) would have failed first and loudly.
 */
async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  // The file's permissions ARE the access control — there is no network, no origin and no token in
  // front of this. Owner and group only; the TLS front runs as root and is unaffected.
  chmodSync(socketPath, SOCKET_MODE);
}

export async function startServer(deps: ServerDeps): Promise<RunningServer | null> {
  if (deps.port === 0) {
    deps.logger.warn('METRICS_PORT=0; the health and metrics endpoints are disabled');
    return null;
  }

  const handler = createHandler(deps);
  const server: Server = createServer(handler);

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

  // A second listener rather than a second implementation: same handler, same routes, same limits.
  let socketServer: Server | null = null;
  if (deps.socketPath) {
    socketServer = createServer(handler);
    socketServer.on('error', (error) => deps.logger.error('metrics socket error', { error }));
    try {
      await listenOnSocket(socketServer, deps.socketPath);
      deps.logger.info('metrics socket listening', { socketPath: deps.socketPath, mode: SOCKET_MODE.toString(8) });
    } catch (error) {
      // Loud, but never fatal. This socket carries error reports; the keeper exists to settle rounds
      // holding real money, and refusing to start over a side-channel would be the worse failure.
      deps.logger.error('metrics socket failed to listen; reports will not be accepted over it', {
        socketPath: deps.socketPath,
        error,
      });
      socketServer = null;
    }
  }

  const closeOne = (target: Server | null): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!target) return resolve();
      target.close(() => resolve());
      target.closeAllConnections?.();
    });

  return {
    port,
    socketPath: socketServer ? deps.socketPath ?? null : null,
    close: async () => {
      await Promise.all([closeOne(server), closeOne(socketServer)]);
      // `close()` unlinks the socket already; this covers the paths where it did not.
      if (deps.socketPath) rmSync(deps.socketPath, { force: true });
    },
  };
}
