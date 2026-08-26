/** A tiny dependency-free Prometheus text-format registry (counters and gauges only). */

export type Labels = Readonly<Record<string, string>>;

export type MetricKind = 'counter' | 'gauge';

interface Series {
  labels: Labels;
  value: number;
}

interface MetricDef {
  name: string;
  help: string;
  kind: MetricKind;
  series: Map<string, Series>;
}

/** Prometheus label values escape backslash, double-quote and newline. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(',') + '}';
}

/** Prometheus wants `1`, `1.5`, `+Inf`, `-Inf`, `NaN`. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export class MetricsRegistry {
  readonly #metrics = new Map<string, MetricDef>();

  #def(name: string, help: string, kind: MetricKind): MetricDef {
    const existing = this.#metrics.get(name);
    if (existing) {
      if (existing.kind !== kind) throw new TypeError(`metric ${name} already registered as ${existing.kind}`);
      return existing;
    }
    if (!NAME_RE.test(name)) throw new TypeError(`invalid metric name: ${name}`);
    const def: MetricDef = { name, help, kind, series: new Map() };
    this.#metrics.set(name, def);
    return def;
  }

  #series(def: MetricDef, labels: Labels): Series {
    const key = formatLabels(labels);
    let s = def.series.get(key);
    if (!s) {
      s = { labels, value: 0 };
      def.series.set(key, s);
    }
    return s;
  }

  /** Register a counter/gauge with zero value so it appears in `/metrics` before it ever moves. */
  declare(name: string, help: string, kind: MetricKind, labels: Labels = {}): void {
    this.#series(this.#def(name, help, kind), labels);
  }

  increment(name: string, help: string, labels: Labels = {}, by = 1): void {
    if (by < 0) throw new RangeError('counters cannot decrease');
    this.#series(this.#def(name, help, 'counter'), labels).value += by;
  }

  setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
    this.#series(this.#def(name, help, 'gauge'), labels).value = value;
  }

  get(name: string, labels: Labels = {}): number | undefined {
    return this.#metrics.get(name)?.series.get(formatLabels(labels))?.value;
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const lines: string[] = [];
    const names = [...this.#metrics.keys()].sort();
    for (const name of names) {
      const def = this.#metrics.get(name) as MetricDef;
      lines.push(`# HELP ${name} ${def.help.replace(/\\/g, '\\\\').replace(/\n/g, ' ')}`);
      lines.push(`# TYPE ${name} ${def.kind}`);
      const keys = [...def.series.keys()].sort();
      for (const key of keys) {
        const s = def.series.get(key) as Series;
        lines.push(`${name}${key} ${formatValue(s.value)}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

/**
 * Value of `updown_keeper_seconds_since_last_execution` for a market this keeper has never executed.
 *
 * A negative sentinel rather than an age, because there is no age: exporting `now - bootTime` there
 * makes a market that was bootstrapped a moment ago and one that has been stalled for hours read
 * identically, and every `> 2 * interval` alert on the series is then measuring process uptime.
 */
export const NEVER_EXECUTED = -1;

/** Metric names, in one place so the dashboard and the code cannot drift. */
export const M = {
  up: 'updown_keeper_up',
  info: 'updown_keeper_info',
  executions: 'updown_keeper_executions_total',
  failures: 'updown_keeper_failures_total',
  relays: 'updown_keeper_relays_total',
  relayTicks: 'updown_keeper_relay_ticks_total',
  txAttempts: 'updown_keeper_tx_attempts_total',
  txGasUsed: 'updown_keeper_gas_used_total',
  voided: 'updown_keeper_rounds_voided_total',
  recentRounds: 'updown_keeper_recent_rounds_completed',
  recentVoidRatio: 'updown_keeper_recent_void_ratio',
  recentFaultVoidRatio: 'updown_keeper_recent_fault_void_ratio',
  secondsSinceExecution: 'updown_keeper_seconds_since_last_execution',
  lastExecutionLatency: 'updown_keeper_last_execution_latency_ms',
  currentEpoch: 'updown_keeper_current_epoch',
  marketActive: 'updown_keeper_market_active',
  marketHealthy: 'updown_keeper_market_healthy',
  balanceWei: 'updown_keeper_balance_wei',
  balanceNative: 'updown_keeper_balance_native',
  balanceLow: 'updown_keeper_balance_below_floor',
  balanceUnfunded: 'updown_keeper_balance_unfunded',
  priceFetches: 'updown_keeper_price_fetches_total',
  uncaught: 'updown_keeper_uncaught_errors_total',
  clockDrift: 'updown_keeper_clock_drift_seconds',
  healthy: 'updown_keeper_healthy',
} as const;

export const HELP: Readonly<Record<string, string>> = Object.freeze({
  [M.up]: 'Always 1 while the keeper process is serving metrics.',
  [M.info]: 'Static keeper build/runtime labels; value is always 1.',
  [M.executions]: 'Successful executeRound() transactions, by market.',
  [M.failures]: 'Failed keeper operations, by market and kind.',
  [M.relays]: 'Successful relay(price) transactions to a testnet RelayAggregator, by market.',
  [M.relayTicks]:
    'Successful EXTRA relay prints published between boundaries for feed density (RELAY_TICK_MS), by market. Cosmetic: no round settles on one, and they are dropped whenever a boundary relay is due.',
  [M.txAttempts]: 'Transaction send attempts including gas-bumped retries, by market and operation. One per attempt.',
  [M.txGasUsed]: 'Total gas used by keeper transactions, by market and operation.',
  [M.voided]: 'Rounds observed as voided in a keeper-sent executeRound() receipt, by market and reason.',
  [M.recentRounds]:
    'Rounds this keeper saw complete in the recent-settlement window (12 rounds\' worth of time), by market. The sample size behind the void ratios; gate any ratio alert on it.',
  [M.recentVoidRatio]:
    'Share (0-1) of recently completed rounds that voided for ANY reason, by market. A one-sided book voids and that is correct behaviour, so this one is information, not an alert.',
  [M.recentFaultVoidRatio]:
    'Share (0-1) of recently completed rounds that voided for a reason the KEEPER is answerable for (no usable boundary print, never locked, settlement window elapsed), by market. Above 0.5 with a sample of 4+ fails /healthz.',
  [M.secondsSinceExecution]:
    'Seconds since the last successful executeRound(), by market. -1 when this keeper has not executed the market at all yet.',
  [M.lastExecutionLatency]: 'Wall-clock milliseconds of the most recent execution tick, by market.',
  [M.currentEpoch]: 'The epoch currently accepting bets, by market.',
  [M.marketActive]: '1 when the market is unpaused and genesis-started, else 0.',
  [M.marketHealthy]: '1 when the market is within its execution budget, else 0.',
  [M.balanceWei]: 'Keeper account balance in wei (float64, so approximate above ~0.009 BNB; use updown_keeper_balance_native for alerting).',
  [M.balanceNative]: 'Keeper account balance in BNB.',
  [M.balanceLow]: '1 when the keeper balance is below the configured floor, else 0.',
  [M.balanceUnfunded]: '1 when the keeper cannot pay for a settlement transaction at all, else 0. Fails /healthz.',
  [M.priceFetches]: 'Spot price fetches, by symbol and outcome.',
  [M.uncaught]: 'Uncaught exceptions and unhandled rejections swallowed to keep the keeper alive.',
  [M.clockDrift]:
    'Chain clock minus local clock, in seconds, re-sampled every 30s. Positive means this host is behind the chain. Wakes are corrected for it; a persistent non-zero value is a broken host clock.',
  [M.healthy]: '1 when every supervised market is within its execution budget, else 0.',
});
