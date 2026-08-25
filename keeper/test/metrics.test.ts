import { describe, expect, it } from 'vitest';
import { escapeLabelValue, formatLabels, formatValue, M, MetricsRegistry } from '../src/metrics.js';

describe('MetricsRegistry', () => {
  it('renders counters and gauges in Prometheus text format', () => {
    const registry = new MetricsRegistry();
    registry.increment('updown_keeper_executions_total', 'Executions.', { market: 'btcUsd5m' });
    registry.increment('updown_keeper_executions_total', 'Executions.', { market: 'btcUsd5m' });
    registry.setGauge('updown_keeper_balance_native', 'Balance.', 1.25);

    expect(registry.render()).toBe(
      [
        '# HELP updown_keeper_balance_native Balance.',
        '# TYPE updown_keeper_balance_native gauge',
        'updown_keeper_balance_native 1.25',
        '# HELP updown_keeper_executions_total Executions.',
        '# TYPE updown_keeper_executions_total counter',
        'updown_keeper_executions_total{market="btcUsd5m"} 2',
        '',
      ].join('\n'),
    );
  });

  it('keeps one series per label set', () => {
    const registry = new MetricsRegistry();
    registry.increment('m_total', 'help', { market: 'a' });
    registry.increment('m_total', 'help', { market: 'b' }, 5);
    expect(registry.get('m_total', { market: 'a' })).toBe(1);
    expect(registry.get('m_total', { market: 'b' })).toBe(5);
  });

  it('declares a zero series so a metric exists before it first moves', () => {
    const registry = new MetricsRegistry();
    registry.declare(M.failures, 'help', 'counter', { market: 'btcUsd5m', kind: 'send' });
    expect(registry.render()).toContain('updown_keeper_failures_total{kind="send",market="btcUsd5m"} 0');
  });

  it('overwrites a gauge but accumulates a counter', () => {
    const registry = new MetricsRegistry();
    registry.setGauge('g', 'help', 1);
    registry.setGauge('g', 'help', 9);
    expect(registry.get('g')).toBe(9);
    registry.increment('c_total', 'help');
    registry.increment('c_total', 'help');
    expect(registry.get('c_total')).toBe(2);
  });

  it('refuses to decrement a counter or reuse a name across types', () => {
    const registry = new MetricsRegistry();
    registry.increment('c_total', 'help');
    expect(() => registry.increment('c_total', 'help', {}, -1)).toThrow(RangeError);
    expect(() => registry.setGauge('c_total', 'help', 1)).toThrow(TypeError);
  });

  it('refuses an invalid metric name', () => {
    expect(() => new MetricsRegistry().setGauge('bad-name', 'help', 1)).toThrow(TypeError);
  });

  it('sorts metrics and labels so scrapes are byte-stable', () => {
    const registry = new MetricsRegistry();
    registry.setGauge('z_gauge', 'z', 1, { b: '2', a: '1' });
    registry.setGauge('a_gauge', 'a', 1);
    const lines = registry.render().split('\n');
    expect(lines[0]).toContain('a_gauge');
    expect(registry.render()).toContain('z_gauge{a="1",b="2"} 1');
  });
});

describe('label and value formatting', () => {
  it('escapes the three characters Prometheus reserves in a label value', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('omits the brace block when there are no labels', () => {
    expect(formatLabels({})).toBe('');
  });

  it('renders special floats the way Prometheus expects', () => {
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(Infinity)).toBe('+Inf');
    expect(formatValue(-Infinity)).toBe('-Inf');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(3.5)).toBe('3.5');
  });
});
