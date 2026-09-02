import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/server.js';
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
