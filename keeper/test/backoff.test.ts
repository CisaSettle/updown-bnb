import { describe, expect, it } from 'vitest';
import {
  bumpGasPrice,
  classifyFailure,
  computeBackoff,
  DEFAULT_BACKOFF,
  errorText,
  type BackoffOptions,
  isContractRejection,
  isNonceError,
} from '../src/backoff.js';

const deterministic: BackoffOptions = { baseMs: 100, factor: 2, maxMs: 1_000, jitter: 0 };

describe('computeBackoff', () => {
  it('doubles each attempt', () => {
    expect(computeBackoff(0, deterministic)).toBe(100);
    expect(computeBackoff(1, deterministic)).toBe(200);
    expect(computeBackoff(2, deterministic)).toBe(400);
    expect(computeBackoff(3, deterministic)).toBe(800);
  });

  it('saturates at maxMs instead of growing without bound', () => {
    expect(computeBackoff(4, deterministic)).toBe(1_000);
    expect(computeBackoff(50, deterministic)).toBe(1_000);
  });

  it('applies symmetric jitter around the nominal delay', () => {
    const options: BackoffOptions = { ...deterministic, jitter: 0.5 };
    expect(computeBackoff(1, options, () => 0)).toBe(100); // 200 - 50%
    expect(computeBackoff(1, options, () => 0.5)).toBe(200);
    expect(computeBackoff(1, options, () => 1)).toBe(300); // 200 + 50%
  });

  it('never exceeds maxMs even with jitter at the top of its range', () => {
    const options: BackoffOptions = { ...deterministic, jitter: 1 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(computeBackoff(attempt, options, () => 1)).toBeLessThanOrEqual(options.maxMs);
      expect(computeBackoff(attempt, options, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it('ships a sane default ladder', () => {
    expect(computeBackoff(0, { ...DEFAULT_BACKOFF, jitter: 0 })).toBe(750);
    expect(computeBackoff(3, { ...DEFAULT_BACKOFF, jitter: 0 })).toBe(6_000);
  });

  it('rejects a negative attempt', () => {
    expect(() => computeBackoff(-1, deterministic)).toThrow(RangeError);
  });
});

describe('bumpGasPrice', () => {
  const max = 50_000_000_000n; // 50 gwei

  it('leaves the first attempt at the base price', () => {
    expect(bumpGasPrice(1_000_000_000n, 0, 25, max)).toBe(1_000_000_000n);
  });

  it('compounds the bump per attempt, so a replacement always beats its predecessor', () => {
    expect(bumpGasPrice(1_000_000_000n, 1, 25, max)).toBe(1_250_000_000n);
    expect(bumpGasPrice(1_000_000_000n, 2, 25, max)).toBe(1_562_500_000n);
    expect(bumpGasPrice(1_000_000_000n, 3, 25, max)).toBe(1_953_125_000n);
  });

  it('is strictly increasing even when integer division would round the bump away', () => {
    // 1 wei * 25% rounds down to 1 wei, which the mempool would reject as underpriced.
    expect(bumpGasPrice(1n, 1, 25, max)).toBe(2n);
    expect(bumpGasPrice(1n, 2, 25, max)).toBe(3n);
  });

  it('never exceeds the configured ceiling', () => {
    expect(bumpGasPrice(40_000_000_000n, 5, 100, max)).toBe(max);
    expect(bumpGasPrice(60_000_000_000n, 0, 25, max)).toBe(max);
  });

  it('rejects a non-positive base price and a negative attempt', () => {
    expect(() => bumpGasPrice(0n, 1, 25, max)).toThrow(RangeError);
    expect(() => bumpGasPrice(1n, -1, 25, max)).toThrow(RangeError);
  });
});

describe('classifyFailure', () => {
  it.each([
    'replacement transaction underpriced',
    'transaction underpriced',
    'nonce too low',
    'already known',
    'request failed',
    'socket hang up',
    'ETIMEDOUT',
    'HTTP 429 too many requests',
    'service unavailable',
  ])('treats %j as retryable', (message) => {
    expect(classifyFailure(new Error(message))).toBe('retryable');
  });

  it.each([
    'execution reverted',
    'execution reverted with reason TooEarly',
    'insufficient funds for gas * price + value',
    'intrinsic gas too low',
  ])('treats %j as terminal', (message) => {
    expect(classifyFailure(new Error(message))).toBe('terminal');
  });

  it('treats a revert as terminal even when the message also mentions a timeout', () => {
    expect(classifyFailure(new Error('request timed out: execution reverted'))).toBe('terminal');
  });

  it('defaults an unrecognised failure to retryable, because giving up costs a round', () => {
    expect(classifyFailure(new Error('something unusual'))).toBe('retryable');
    expect(classifyFailure(undefined)).toBe('retryable');
  });

  it('sees through a viem-style nested cause', () => {
    const inner = new Error('execution reverted');
    const outer = new Error('ContractFunctionExecutionError', { cause: inner });
    expect(classifyFailure(outer)).toBe('terminal');
  });
});

describe('errorText', () => {
  it('flattens viem metadata and the cause chain into one searchable string', () => {
    const inner = Object.assign(new Error('boom'), { shortMessage: 'short', details: 'detail text' });
    const outer = new Error('outer', { cause: inner });
    const text = errorText(outer);
    expect(text).toContain('outer');
    expect(text).toContain('boom');
    expect(text).toContain('short');
    expect(text).toContain('detail text');
  });

  it('handles plain objects and primitives without throwing', () => {
    expect(errorText({ code: -32000, message: 'nope' })).toContain('nope');
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText(null)).toBe('');
  });

  it('terminates on a self-referencing cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(() => errorText(a)).not.toThrow();
  });
});

describe('isNonceError', () => {
  it('matches the node phrasings that mean the nonce slot is spent', () => {
    for (const text of [
      'nonce too low: address 0x… next nonce 12, tx nonce 11',
      'Nonce too high',
      'invalid nonce',
      'nonce has already been used',
      'OldNonce',
    ]) {
      expect(isNonceError(new Error(text))).toBe(true);
    }
  });

  it('does NOT match the cases where the nonce is still ours and pending', () => {
    // Re-reading the nonce here would return the same value; the answer is a higher gas price.
    expect(isNonceError(new Error('already known'))).toBe(false);
    expect(isNonceError(new Error('replacement transaction underpriced'))).toBe(false);
    expect(isNonceError(new Error('execution reverted'))).toBe(false);
    expect(isNonceError(new Error('request timeout'))).toBe(false);
    expect(isNonceError(undefined)).toBe(false);
  });

  it('sees through a viem-shaped cause chain', () => {
    const inner = new Error('nonce too low');
    const outer = Object.assign(new Error('Transaction failed'), { cause: inner });
    expect(isNonceError(outer)).toBe(true);
  });
});

describe('isContractRejection', () => {
  it('recognises the contract itself refusing, which `_tryRound` reads as "no such print"', () => {
    for (const text of [
      'execution reverted',
      'The contract function "getRoundData" reverted with the following reason: No data present.',
      'No data present',
      'The contract function "getRoundData" returned no data ("0x")',
      'invalid opcode',
    ]) {
      expect(isContractRejection(new Error(text))).toBe(true);
    }
  });

  it('does NOT call a failed read an absence, which is the whole point', () => {
    // "We could not look" is not "there is nothing there". Reading these as absence is what let a
    // transient RPC failure stand in for a phase that never existed and time a settleable round out.
    for (const text of [
      'HTTP request failed.',
      'fetch failed',
      'The request took too long to respond.',
      'ETIMEDOUT',
      '429 Too Many Requests',
      '502 Bad Gateway',
      'socket hang up',
    ]) {
      expect(isContractRejection(new Error(text))).toBe(false);
    }
    expect(isContractRejection(undefined)).toBe(false);
  });

  it('sees through a viem-shaped cause chain', () => {
    const inner = new Error('execution reverted');
    const outer = Object.assign(new Error('Contract call failed'), { cause: inner });
    expect(isContractRejection(outer)).toBe(true);
  });
});
