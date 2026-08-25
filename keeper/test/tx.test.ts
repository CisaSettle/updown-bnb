import { describe, expect, it, vi } from 'vitest';
import {
  applyGasPremium,
  ExhaustedTxError,
  isTimeout,
  padGas,
  sendWithRetry,
  TerminalTxError,
  TxQueue,
  type AttemptEvent,
  type MinimalReceipt,
  type SendDeps,
  type SendPolicy,
} from '../src/tx.js';
import type { Hex } from 'viem';

const HASH_A = ('0x' + 'a'.repeat(64)) as Hex;
const HASH_B = ('0x' + 'b'.repeat(64)) as Hex;

const receipt = (hash: Hex, status: 'success' | 'reverted' = 'success'): MinimalReceipt => ({
  status,
  transactionHash: hash,
  gasUsed: 120_000n,
});

const policy: SendPolicy = {
  maxAttempts: 3,
  backoff: { baseMs: 1, factor: 2, maxMs: 4, jitter: 0 },
  receiptTimeoutMs: 1_000,
  gasBumpPercent: 25,
  maxGasPriceWei: 50_000_000_000n,
};

function deps(over: Partial<SendDeps<MinimalReceipt>> = {}): SendDeps<MinimalReceipt> {
  let clock = 0;
  return {
    getBaseGasPrice: async () => 1_000_000_000n,
    getNonce: async () => 7,
    send: async () => HASH_A,
    waitForReceipt: async (hash) => receipt(hash),
    getReceiptIfMined: async () => null,
    sleep: async () => undefined,
    now: () => (clock += 10),
    random: () => 0.5,
    ...over,
  };
}

describe('TxQueue', () => {
  it('runs submitted work strictly one at a time', async () => {
    const queue = new TxQueue();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([queue.submit(task('a', 20)), queue.submit(task('b', 1))]);
    expect(results).toEqual(['a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('keeps running after a submitted task rejects', async () => {
    const queue = new TxQueue();
    await expect(queue.submit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.submit(async () => 'still works')).resolves.toBe('still works');
  });

  it('reports and drains outstanding depth', async () => {
    const queue = new TxQueue();
    const p = queue.submit(async () => new Promise((r) => setTimeout(r, 5)));
    expect(queue.depth).toBe(1);
    await p;
    await queue.drain();
    expect(queue.depth).toBe(0);
  });
});

describe('sendWithRetry', () => {
  it('returns the receipt on a first-attempt success', async () => {
    const result = await sendWithRetry(policy, deps());
    expect(result.hash).toBe(HASH_A);
    expect(result.attempts).toBe(1);
    expect(result.gasPriceWei).toBe(1_000_000_000n);
  });

  it('re-uses the nonce and bumps the gas price on a timeout', async () => {
    const seen: { nonce: number; gasPriceWei: bigint }[] = [];
    const send = vi.fn(async (ctx) => {
      seen.push({ nonce: ctx.nonce, gasPriceWei: ctx.gasPriceWei });
      return ctx.attempt === 0 ? HASH_A : HASH_B;
    });
    const waitForReceipt = vi.fn(async (hash: Hex) => {
      if (hash === HASH_A) throw new Error('WaitForTransactionReceiptTimeout');
      return receipt(hash);
    });
    const result = await sendWithRetry(policy, deps({ send, waitForReceipt }));
    expect(result.hash).toBe(HASH_B);
    expect(result.attempts).toBe(2);
    // Same nonce -> a replacement, not a duplicate.
    expect(seen.map((s) => s.nonce)).toEqual([7, 7]);
    expect(seen.map((s) => s.gasPriceWei)).toEqual([1_000_000_000n, 1_250_000_000n]);
  });

  it('treats an on-chain revert as terminal and does not retry', async () => {
    const send = vi.fn(async () => HASH_A);
    await expect(
      sendWithRetry(policy, deps({ send, waitForReceipt: async (h) => receipt(h, 'reverted') })),
    ).rejects.toThrow(TerminalTxError);
    expect(send).toHaveBeenCalledOnce();
  });

  it('treats a revert thrown at send time as terminal', async () => {
    const send = vi.fn(async () => {
      throw new Error('execution reverted: TooEarly');
    });
    await expect(sendWithRetry(policy, deps({ send }))).rejects.toThrow(TerminalTxError);
    expect(send).toHaveBeenCalledOnce();
  });

  it('recovers when an earlier attempt landed after all', async () => {
    const send = vi.fn(async (ctx) => {
      if (ctx.attempt === 0) return HASH_A;
      throw new Error('nonce too low');
    });
    const waitForReceipt = vi.fn(async () => {
      throw new Error('timed out');
    });
    const getReceiptIfMined = vi.fn(async (hash: Hex) => (hash === HASH_A ? receipt(HASH_A) : null));
    const result = await sendWithRetry(policy, deps({ send, waitForReceipt, getReceiptIfMined }));
    expect(result.hash).toBe(HASH_A);
  });

  it('surfaces a revert discovered on the recovered receipt', async () => {
    const send = vi.fn(async (ctx) => {
      if (ctx.attempt === 0) return HASH_A;
      throw new Error('already known');
    });
    await expect(
      sendWithRetry(
        policy,
        deps({
          send,
          waitForReceipt: async () => {
            throw new Error('timed out');
          },
          getReceiptIfMined: async () => receipt(HASH_A, 'reverted'),
        }),
      ),
    ).rejects.toThrow(TerminalTxError);
  });

  it('gives up after maxAttempts transient failures', async () => {
    const send = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const error = await sendWithRetry(policy, deps({ send })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExhaustedTxError);
    expect((error as ExhaustedTxError).attempts).toBe(3);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sleeps with backoff between attempts but not after the last one', async () => {
    const sleep = vi.fn(async () => undefined);
    await sendWithRetry(
      policy,
      deps({
        sleep,
        send: async () => {
          throw new Error('fetch failed');
        },
      }),
    ).catch(() => undefined);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
    expect(sleep).toHaveBeenNthCalledWith(2, 2);
  });

  it('reports each attempt to the observer', async () => {
    const events: AttemptEvent[] = [];
    await sendWithRetry(policy, deps({ onAttempt: (e) => events.push(e) }));
    expect(events.map((e) => e.outcome)).toEqual(['sent', 'mined']);
  });

  it('caps the bumped gas price at the configured ceiling', async () => {
    const seen: bigint[] = [];
    await sendWithRetry(
      { ...policy, maxAttempts: 5, maxGasPriceWei: 1_100_000_000n },
      deps({
        send: async (ctx) => {
          seen.push(ctx.gasPriceWei);
          throw new Error('fetch failed');
        },
      }),
    ).catch(() => undefined);
    expect(Math.max(...seen.map(Number))).toBeLessThanOrEqual(1_100_000_000);
  });
});

describe('applyGasPremium', () => {
  it('adds the premium and clamps to the ceiling', () => {
    expect(applyGasPremium(1_000_000_000n, 10, 50_000_000_000n)).toBe(1_100_000_000n);
    expect(applyGasPremium(1_000_000_000n, 0, 50_000_000_000n)).toBe(1_000_000_000n);
    expect(applyGasPremium(60_000_000_000n, 10, 50_000_000_000n)).toBe(50_000_000_000n);
  });

  it('never returns zero, which a node would reject', () => {
    expect(applyGasPremium(0n, 10, 50n)).toBe(1n);
  });
});

describe('padGas', () => {
  it('pads the estimate by the given percentage', () => {
    expect(padGas(100_000n, 25)).toBe(125_000n);
    expect(padGas(100_000n, 0)).toBe(100_000n);
  });
});

describe('isTimeout', () => {
  it('recognises viem and generic timeout messages', () => {
    expect(isTimeout(new Error('WaitForTransactionReceiptTimeoutError'))).toBe(true);
    expect(isTimeout(new Error('request timed out'))).toBe(true);
    expect(isTimeout(new Error('execution reverted'))).toBe(false);
  });
});

describe('sendWithRetry nonce recovery', () => {
  it('re-reads the nonce when the node says the slot is spent', async () => {
    // Without this the whole retry ladder reuses a nonce that can never land again: every
    // remaining attempt is a guaranteed failure and the round is missed.
    const nonces: number[] = [];
    let served = 0;
    const result = await sendWithRetry(policy, {
      ...deps(),
      getNonce: async () => {
        served += 1;
        return served === 1 ? 7 : 9;
      },
      send: async (ctx) => {
        nonces.push(ctx.nonce);
        if (ctx.nonce === 7) throw new Error('nonce too low');
        return HASH_B;
      },
      getReceiptIfMined: async () => null,
    });
    expect(nonces).toEqual([7, 9]);
    expect(result.hash).toBe(HASH_B);
  });

  it('keeps the same nonce for an ordinary transient failure', async () => {
    const nonces: number[] = [];
    let calls = 0;
    await sendWithRetry(policy, {
      ...deps(),
      send: async (ctx) => {
        nonces.push(ctx.nonce);
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return HASH_A;
      },
      getReceiptIfMined: async () => null,
    });
    expect(nonces).toEqual([7, 7]);
  });

  it('reports the new nonce through onAttempt as `renonced`', async () => {
    const events: AttemptEvent[] = [];
    let served = 0;
    await sendWithRetry(policy, {
      ...deps(),
      getNonce: async () => {
        served += 1;
        return served === 1 ? 7 : 8;
      },
      send: async (ctx) => {
        if (ctx.nonce === 7) throw new Error('nonce too low');
        return HASH_A;
      },
      getReceiptIfMined: async () => null,
      onAttempt: (event) => events.push(event),
    });
    const renonced = events.find((e) => e.outcome === 'renonced');
    expect(renonced?.nonce).toBe(8);
  });

  it('survives the nonce re-read itself failing', async () => {
    let served = 0;
    await expect(
      sendWithRetry(policy, {
        ...deps(),
        getNonce: async () => {
          served += 1;
          if (served > 1) throw new Error('rpc down');
          return 7;
        },
        send: async () => {
          throw new Error('nonce too low');
        },
        getReceiptIfMined: async () => null,
      }),
    ).rejects.toBeInstanceOf(ExhaustedTxError);
  });
});
