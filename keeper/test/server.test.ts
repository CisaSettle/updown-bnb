import { describe, expect, it } from 'vitest';
import { MAX_REPORT_BYTES, handleRequest, readCappedBody, startServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { ClientErrorSink } from '../src/clientErrors.js';
import { Readable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { MetricsRegistry } from '../src/metrics.js';
import type { HealthReport } from '../src/health.js';

const healthy: HealthReport = {
  healthy: true,
  uptimeSec: 42,
  markets: [
    {
      name: 'btcUsd5m',
      address: '0x00000000000000000000000000000000000000aa',
      state: 'ok',
      healthy: true,
      secondsSinceExecution: 12,
      budgetSec: 600,
      reason: 'ok',
      settlement: null,
      paused: false,
      pausedSettlement: 'none',
    },
  ],
  warnings: [],
  blockers: [],
  uncaught: { count: 0, latest: null },
};

const unhealthy: HealthReport = {
  ...healthy,
  healthy: false,
  markets: [
    {
      name: 'btcUsd5m',
      address: '0x00000000000000000000000000000000000000aa',
      state: 'stale',
      healthy: false,
      secondsSinceExecution: 900,
      budgetSec: 600,
      reason: 'late',
      settlement: null,
      paused: false,
      pausedSettlement: 'none',
    },
  ],
  warnings: ['keeper balance is low'],
};

const deps = (health: HealthReport) => {
  const metrics = new MetricsRegistry();
  metrics.setGauge('updown_keeper_up', 'up', 1);
  return { metrics, health: () => health, version: '1.0.0' };
};

describe('handleRequest', () => {
  it('returns 200 from /healthz when every market is inside its budget', () => {
    const res = handleRequest('/healthz', deps(healthy));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).healthy).toBe(true);
  });

  it('returns 503 from /healthz when a market is stale, so a load balancer sheds it', () => {
    const res = handleRequest('/healthz', deps(unhealthy));
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.markets[0].state).toBe('stale');
    expect(body.warnings).toContain('keeper balance is low');
  });

  it('serves the Prometheus content type from /metrics', () => {
    const res = handleRequest('/metrics', deps(healthy));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toContain('updown_keeper_up 1');
  });

  it('ignores the query string when routing', () => {
    expect(handleRequest('/metrics?format=text', deps(healthy)).status).toBe(200);
  });

  it('serves a service banner at the root', () => {
    const res = handleRequest('/', deps(healthy));
    expect(JSON.parse(res.body).service).toBe('updown-keeper');
  });

  it('404s anything else', () => {
    expect(handleRequest('/admin', deps(healthy)).status).toBe(404);
  });
});

/**
 * `/client-error` is the only route that accepts input, and it runs in the process that holds the
 * keeper's signing key. These are the bounds, not the features.
 */
describe('the report route', () => {
  const withSink = (sink: ClientErrorSink) => ({ ...deps(healthy), clientErrors: sink, now: () => 0 });
  const body = JSON.stringify({ v: 1, kind: 'unclassified', sig: 'InsufficientFundsError/-32000' });

  it('does not exist until an operator switches it on', () => {
    expect(handleRequest('/client-error', deps(healthy), { method: 'POST', body }).status).toBe(404);
    // …and the index does not advertise a route that is not there.
    expect(JSON.parse(handleRequest('/', deps(healthy)).body).endpoints).toEqual(['/healthz', '/metrics']);
  });

  it('accepts a POST and counts it', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    const res = handleRequest('/client-error', withSink(sink), { method: 'POST', body });
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
    expect(sink.summary().count).toBe(1);
  });

  // The answer must never vary with the outcome: telling an unauthenticated caller whether their
  // report was accepted, malformed or rate-limited is telling them how to tune a flood.
  it('answers 204 whatever it decided', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 1, maxSignatures: 8, allowedOrigins: ['https://updown.bluffking.ai'] });
    const cases = [
      { method: 'POST', body, origin: 'https://updown.bluffking.ai' },
      { method: 'POST', body: 'garbage', origin: 'https://updown.bluffking.ai' },
      { method: 'POST', body, origin: 'https://evil.example' },
      { method: 'POST', body, origin: 'https://updown.bluffking.ai' },
    ];
    for (const request of cases) {
      expect(handleRequest('/client-error', withSink(sink), request).status).toBe(204);
    }
    expect(sink.summary().count).toBe(1);
  });

  it('refuses anything but POST, and never reads a GET as a report', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    expect(handleRequest('/client-error', withSink(sink), { method: 'GET' }).status).toBe(405);
    expect(sink.summary().count).toBe(0);
  });

  // A body that hit the cap is discarded rather than parsed: half a JSON document is not a report,
  // and treating it as one is how a size limit becomes a parser bug.
  it('discards a truncated body instead of parsing what arrived', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    expect(handleRequest('/client-error', withSink(sink), { method: 'POST', body, truncated: true }).status).toBe(204);
    expect(sink.summary().count).toBe(0);
    expect(sink.summary().refused).toBe(1);
  });

  it('leaves /healthz and /metrics exactly as they were', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    expect(handleRequest('/healthz', withSink(sink)).status).toBe(200);
    expect(handleRequest('/metrics', withSink(sink)).status).toBe(200);
    expect(handleRequest('/nope', withSink(sink)).status).toBe(404);
  });
});

/**
 * The cap has to be enforced on the way IN. Collecting an unbounded body and measuring it
 * afterwards is precisely the memory exhaustion it guards against, on an endpoint with no auth.
 */
describe('the body cap', () => {
  const asRequest = (chunks: string[]): IncomingMessage => {
    const stream = Readable.from(chunks) as unknown as IncomingMessage;
    // `readCappedBody` calls destroy() on overrun; Readable.from provides it.
    return stream;
  };

  it('reads a small body whole', async () => {
    expect(await readCappedBody(asRequest(['{"v":1}']))).toEqual({ body: '{"v":1}', truncated: false });
  });

  // A string chunk's `.length` is characters, not bytes; measuring it that way would let a
  // multi-byte body through at several times the cap.
  it('measures bytes, not characters', async () => {
    const multibyte = '\u4e00'.repeat(MAX_REPORT_BYTES); // 3 bytes each
    expect((await readCappedBody(asRequest([multibyte]))).truncated).toBe(true);
  });

  it('destroys the connection the moment a body overruns, and keeps nothing', async () => {
    const oversized = 'x'.repeat(MAX_REPORT_BYTES + 1);
    const result = await readCappedBody(asRequest([oversized]));
    expect(result.truncated).toBe(true);
    expect(result.body).toBe('');
  });

  it('cuts off a body that only overruns partway through', async () => {
    const half = 'y'.repeat(Math.ceil(MAX_REPORT_BYTES / 2) + 1);
    const result = await readCappedBody(asRequest([half, half]));
    expect(result.truncated).toBe(true);
    expect(result.body).toBe('');
  });
});

/**
 * Over a real socket. The pure tests above cover the decision; this covers the thing that actually
 * faces the network — the streaming read, the header parsing and the response — because that is the
 * part an unauthenticated caller reaches.
 */
describe('the report route over a real socket', () => {
  it('accepts a beacon, refuses an oversized body, and never blocks /healthz', async () => {
    const sink = new ClientErrorSink({ maxPerMinute: 100, maxSignatures: 8, allowedOrigins: ['https://updown.bluffking.ai'] });
    // `port: 0` means "disabled" to startServer, so an ephemeral port has to be borrowed first.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const found = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(found));
      });
    });
    const server = await startServer({
      port,
      host: '127.0.0.1',
      metrics: new MetricsRegistry(),
      health: () => healthy,
      logger: createLogger({ level: 'error', write: () => {} }),
      version: '1.0.0',
      clientErrors: sink,
    });
    expect(server).not.toBeNull();
    const base = `http://127.0.0.1:${server?.port}`;
    try {
      // Exactly what `navigator.sendBeacon` sends: text/plain, no preflight.
      const ok = await fetch(`${base}/client-error`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://updown.bluffking.ai' },
        body: JSON.stringify({ v: 1, kind: 'unclassified', sig: 'InsufficientFundsError/-32000' }),
      });
      expect(ok.status).toBe(204);
      expect(sink.summary().count).toBe(1);

      // Oversized: the connection is destroyed mid-read, so the client sees a failure rather than a
      // response — and crucially nothing was buffered and nothing was counted.
      await fetch(`${base}/client-error`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://updown.bluffking.ai' },
        body: 'x'.repeat(MAX_REPORT_BYTES * 4),
      }).catch(() => undefined);
      expect(sink.summary().count).toBe(1);

      // The operational surface is unchanged by any of it.
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { healthy: boolean }).healthy).toBe(true);
    } finally {
      await server?.close();
    }
  });
});

/**
 * The unix socket is how the TLS front reaches this process without anything new appearing on a
 * network interface — on the production host the TCP listener is deliberately loopback-only and ufw
 * denies the container-to-host path outright. The socket file's permissions are the entire access
 * control, so they are asserted, not assumed.
 */
describe('the unix socket listener', () => {
  const overSocket = (socketPath: string, path: string, method = 'GET', body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ socketPath, path, method, headers: { origin: 'https://updown.bluffking.ai' } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  const boot = async (socketPath: string, sink: ClientErrorSink) => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const found = typeof a === 'object' && a !== null ? a.port : 0;
        probe.close(() => resolve(found));
      });
    });
    return startServer({
      port,
      host: '127.0.0.1',
      metrics: new MetricsRegistry(),
      health: () => healthy,
      logger: createLogger({ level: 'error', write: () => {} }),
      version: '1.0.0',
      clientErrors: sink,
      socketPath,
    });
  };

  it('serves the same routes as the port, and only the owner may reach it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'updown-sock-'));
    const socketPath = join(dir, 'keeper.sock');
    const sink = new ClientErrorSink({ maxPerMinute: 100, maxSignatures: 8, allowedOrigins: ['https://updown.bluffking.ai'] });
    const server = await boot(socketPath, sink);
    try {
      expect(server?.socketPath).toBe(socketPath);
      // 0660: no world access. The file IS the access control.
      expect(statSync(socketPath).mode & 0o777).toBe(0o660);

      const report = await overSocket(socketPath, '/client-error', 'POST', JSON.stringify({ v: 1, kind: 'unclassified', sig: 'InsufficientFundsError/-32000' }));
      expect(report.status).toBe(204);
      expect(sink.summary().count).toBe(1);

      const health = await overSocket(socketPath, '/healthz');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body).healthy).toBe(true);

      // The TCP listener is untouched — the watchdog still polls it.
      const viaPort = await fetch(`http://127.0.0.1:${server?.port}/healthz`);
      expect(viaPort.status).toBe(200);
    } finally {
      await server?.close();
    }
    // Cleaned up on close, so a restart does not trip over its own leftover.
    expect(existsSync(socketPath)).toBe(false);
  });

  // A socket file outlives SIGKILL. Without this, one hard kill leaves a keeper that refuses to
  // start until somebody deletes a file by hand.
  it('starts over a stale socket left by a killed process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'updown-stale-'));
    const socketPath = join(dir, 'keeper.sock');
    writeFileSync(socketPath, 'leftover');
    chmodSync(socketPath, 0o600);
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    const server = await boot(socketPath, sink);
    try {
      expect((await overSocket(socketPath, '/healthz')).status).toBe(200);
    } finally {
      await server?.close();
    }
  });

  // The keeper settles rounds holding real money. A side-channel for error reports must never be
  // able to stop it starting.
  it('still starts when the socket cannot be created', async () => {
    const socketPath = '/nonexistent-directory-updown/keeper.sock';
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    const server = await boot(socketPath, sink);
    try {
      expect(server).not.toBeNull();
      expect(server?.socketPath).toBeNull();
      const viaPort = await fetch(`http://127.0.0.1:${server?.port}/healthz`);
      expect(viaPort.status).toBe(200);
    } finally {
      await server?.close();
    }
  });
});
