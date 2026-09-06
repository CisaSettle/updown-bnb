/**
 * The report sink is the only input surface this process has, and it runs beside the keeper's
 * signing key. Everything asserted here is a bound on what an unauthenticated caller can do.
 */

import { describe, expect, it } from 'vitest';
import { ClientErrorSink, parseReport, sanitizeSignature } from '../src/clientErrors.js';

const OK = JSON.stringify({ v: 1, kind: 'unclassified', sig: 'InsufficientFundsError/-32000', n: 1 });

describe('what the sink will accept', () => {
  it('takes the shape the page sends, and nothing else', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    expect(sink.record(OK, undefined, 0)).toBe('accepted');
    expect(sink.record('not json at all', undefined, 0)).toBe('malformed');
    expect(sink.record(JSON.stringify({ kind: 'x', sig: 'y' }), undefined, 0)).toBe('malformed');
    // A future schema is refused rather than guessed at.
    expect(sink.record(JSON.stringify({ v: 2, kind: 'x', sig: 'y' }), undefined, 0)).toBe('malformed');
    expect(sink.record(JSON.stringify({ v: 1, kind: 'x' }), undefined, 0)).toBe('malformed');
    expect(sink.record('[]', undefined, 0)).toBe('malformed');
    expect(sink.summary().count).toBe(1);
    expect(sink.summary().refused).toBe(5);
  });

  // The signature ends up inside a Telegram message. A newline would forge a second alert line, and
  // an emoji costs two of Telegram's 4096 UTF-16 units — neither belongs in an identifier.
  it('strips anything a browser could use to forge an alert line', () => {
    expect(sanitizeSignature('Error/-32000')).toBe('Error/-32000');
    expect(sanitizeSignature('a\nRED ALERT: keeper down')).toBe('a.RED.ALERT:.keeper.down');
    expect(sanitizeSignature('🔴🔴🔴')).toBe(null);
    expect(sanitizeSignature('x'.repeat(500))?.length).toBe(120);
    expect(sanitizeSignature(42)).toBe(null);
    expect(sanitizeSignature('')).toBe(null);
  });

  it('refuses to let one report claim an unbounded number of occurrences', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    sink.record(JSON.stringify({ v: 1, kind: 'k', sig: 's', n: 1e9 }), undefined, 0);
    expect(sink.summary().count).toBe(100);
    expect(parseReport(JSON.stringify({ v: 1, kind: 'k', sig: 's', n: -5 }))?.n).toBe(1);
  });
});

describe('the bounds on an unauthenticated caller', () => {
  it('stops counting past the per-minute ceiling, and starts again in the next window', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 3, maxSignatures: 8, allowedOrigins: [] });
    for (let i = 0; i < 10; i += 1) sink.record(OK, undefined, 1_000);
    expect(sink.summary().count).toBe(3);
    expect(sink.summary().refused).toBe(7);
    sink.record(OK, undefined, 62_000);
    expect(sink.summary().count).toBe(4);
  });

  // The one way a caller could grow the map without bound. On a 2 vCPU box that is an OOM, not an
  // inconvenience — so the excess still counts, and only its breakdown is lost.
  it('caps distinct signatures without losing the fact that they happened', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 1_000, maxSignatures: 2, allowedOrigins: [] });
    for (let i = 0; i < 20; i += 1) sink.record(JSON.stringify({ v: 1, kind: 'k', sig: `sig${i}` }), undefined, 0);
    const summary = sink.summary();
    expect(summary.count).toBe(20);
    expect(summary.signatures).toHaveLength(2);
    expect(summary.dropped).toBe(18);
  });

  it('filters by origin when one is configured, and by nothing when none is', () => {
    const strict = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: ['https://updown.bluffking.ai'] });
    expect(strict.record(OK, 'https://evil.example', 0)).toBe('bad-origin');
    expect(strict.record(OK, undefined, 0)).toBe('bad-origin');
    expect(strict.record(OK, 'https://updown.bluffking.ai', 0)).toBe('accepted');

    const open = new ClientErrorSink({ maxPerMinute: 10, maxSignatures: 8, allowedOrigins: [] });
    expect(open.record(OK, 'https://anywhere.example', 0)).toBe('accepted');
  });

  it('ranks the loudest signatures first, so a digest names what is actually happening', () => {
    const sink = new ClientErrorSink({ maxPerMinute: 1_000, maxSignatures: 8, allowedOrigins: [] });
    for (let i = 0; i < 5; i += 1) sink.record(JSON.stringify({ v: 1, kind: 'k', sig: 'loud' }), undefined, 0);
    sink.record(JSON.stringify({ v: 1, kind: 'k', sig: 'quiet' }), undefined, 0);
    expect(sink.summary().signatures).toEqual([
      { sig: 'k/loud', n: 5 },
      { sig: 'k/quiet', n: 1 },
    ]);
  });
});
