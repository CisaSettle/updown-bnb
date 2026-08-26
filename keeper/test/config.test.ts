import { describe, expect, it } from 'vitest';
import { bnbToWei, ConfigError, gweiToWei, loadConfig, normalisePrivateKey, redactUrl } from '../src/config.js';
import { parseDeployment, type DeploymentFile } from '../src/deployments.js';

// A well-known test key (Anvil account #0). Never used for anything real.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const deploymentJson = {
  chainId: 97,
  registry: '0x1111111111111111111111111111111111111111',
  btcUsd5m: '0x2222222222222222222222222222222222222222',
  btcFeed: '0x5555555555555555555555555555555555555555',
  usdt: '0x7777777777777777777777777777777777777777',
  owner: '0x8888888888888888888888888888888888888888',
  operator: '0x9999999999999999999999999999999999999999',
  relayFeeds: true,
  feeBps: 300,
};

const deployment: DeploymentFile = parseDeployment(deploymentJson, 97, '/fake/97.json');
const loadDeploymentImpl = () => deployment;

const baseEnv = {
  CHAIN_ID: '97',
  RPC_URL: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  KEEPER_PRIVATE_KEY: TEST_KEY,
};

const load = (env: Record<string, string | undefined>) => loadConfig({ env, loadDeploymentImpl });

describe('loadConfig', () => {
  it('accepts the minimal environment and derives the keeper address', () => {
    const config = load(baseEnv);
    expect(config.chainId).toBe(97);
    expect(config.keeperAddress).toBe(TEST_ADDRESS);
    expect(config.deployment.markets).toHaveLength(1);
  });

  it('applies the documented defaults', () => {
    const config = load(baseEnv);
    expect(config.logLevel).toBe('info');
    expect(config.metricsPort).toBe(9464);
    expect(config.price.endpoint).toBe('https://api.binance.com/api/v3/ticker/price');
    expect(config.schedule.executeLeadMs).toBe(2_000);
    // Per RELAY, not per boundary: the scheduler multiplies it by the relays sharing the queue.
    expect(config.schedule.relayLeadMs).toBe(20_000);
    expect(config.health.intervalsAllowed).toBe(2);
    expect(config.health.minBalanceWei).toBe(50_000_000_000_000_000n);
    expect(config.tx.maxAttempts).toBe(4);
    expect(config.dryRun).toBe(false);
    // A total bootstrap failure degrades by default; exiting for a supervisor is opt-in, so that
    // whether the process survives a transient RPC outage is a decision and not an accident.
    expect(config.exitOnTotalBootstrapFailure).toBe(false);
  });

  it('lets the operator choose to exit when nothing bootstraps', () => {
    expect(load({ ...baseEnv, EXIT_ON_TOTAL_BOOTSTRAP_FAILURE: 'true' }).exitOnTotalBootstrapFailure).toBe(true);
    expect(() => load({ ...baseEnv, EXIT_ON_TOTAL_BOOTSTRAP_FAILURE: 'maybe' })).toThrow(
      /EXIT_ON_TOTAL_BOOTSTRAP_FAILURE must be a boolean/,
    );
  });

  it('accepts a private key without the 0x prefix', () => {
    const config = load({ ...baseEnv, KEEPER_PRIVATE_KEY: TEST_KEY.slice(2) });
    expect(config.keeperAddress).toBe(TEST_ADDRESS);
  });

  it('reports every problem at once instead of one per restart', () => {
    const error = (() => {
      try {
        load({ CHAIN_ID: '1', RPC_URL: 'not-a-url', KEEPER_PRIVATE_KEY: 'short', LOG_LEVEL: 'chatty' });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toMatch(/CHAIN_ID must be 56/);
    expect(error?.message).toMatch(/KEEPER_PRIVATE_KEY must be a 32-byte hex private key/);
    expect(error?.message).toMatch(/LOG_LEVEL must be one of/);
  });

  it('never echoes the private key in the rejection message', () => {
    try {
      load({ ...baseEnv, KEEPER_PRIVATE_KEY: 'deadbeef' });
    } catch (error) {
      expect((error as Error).message).not.toContain('deadbeef');
    }
    expect.assertions(1);
  });

  it('requires CHAIN_ID, RPC_URL and KEEPER_PRIVATE_KEY', () => {
    expect(() => load({})).toThrow(/CHAIN_ID is required/);
    expect(() => load({ CHAIN_ID: '97', KEEPER_PRIVATE_KEY: TEST_KEY, RPC_URL: '' })).not.toThrow();
    expect(() => load({ CHAIN_ID: '97', RPC_URL: baseEnv.RPC_URL })).toThrow(/KEEPER_PRIVATE_KEY is required/);
  });

  it('falls back to the public RPC for the chain when RPC_URL is blank', () => {
    const config = load({ ...baseEnv, RPC_URL: '' });
    expect(config.rpcUrl).toBe('https://data-seed-prebsc-1-s1.bnbchain.org:8545');
  });

  it('surfaces a deployments-file failure as a configuration error', () => {
    expect(() =>
      loadConfig({
        env: baseEnv,
        loadDeploymentImpl: () => {
          throw new ConfigError('deployments file not found: /repo/contracts/deployments/97.json');
        },
      }),
    ).toThrow(/deployments file not found/);
  });

  it('validates numeric bounds rather than accepting nonsense', () => {
    expect(() => load({ ...baseEnv, METRICS_PORT: '70000' })).toThrow(/METRICS_PORT must be between 0 and 65535/);
    expect(() => load({ ...baseEnv, TX_MAX_ATTEMPTS: '0' })).toThrow(/TX_MAX_ATTEMPTS must be between 1 and 10/);
    expect(() => load({ ...baseEnv, EXECUTE_LEAD_MS: 'soon' })).toThrow(/EXECUTE_LEAD_MS must be an integer/);
    expect(() => load({ ...baseEnv, DRY_RUN: 'maybe' })).toThrow(/DRY_RUN must be a boolean/);
  });

  it('parses booleans in every common spelling', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(load({ ...baseEnv, DRY_RUN: value }).dryRun).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(load({ ...baseEnv, DRY_RUN: value }).dryRun).toBe(false);
    }
  });

  it('converts gas settings from gwei to wei and rejects a fixed price above the ceiling', () => {
    const config = load({ ...baseEnv, GAS_PRICE_GWEI: '3', MAX_GAS_PRICE_GWEI: '20' });
    expect(config.tx.fixedGasPriceWei).toBe(3_000_000_000n);
    expect(config.tx.maxGasPriceWei).toBe(20_000_000_000n);
    expect(() => load({ ...baseEnv, GAS_PRICE_GWEI: '30', MAX_GAS_PRICE_GWEI: '20' })).toThrow(/exceeds MAX_GAS_PRICE_GWEI/);
  });

  it('parses SYMBOL_MAP and normalises its keys', () => {
    const config = load({ ...baseEnv, SYMBOL_MAP: '{"BTC / USD":"btcfdusd"}' });
    expect(config.price.symbolOverrides).toEqual({ 'btc/usd': 'BTCFDUSD' });
  });

  it('rejects a malformed SYMBOL_MAP', () => {
    expect(() => load({ ...baseEnv, SYMBOL_MAP: 'not json' })).toThrow(/SYMBOL_MAP must be a JSON object/);
    expect(() => load({ ...baseEnv, SYMBOL_MAP: '{"BTC / USD": 5}' })).toThrow(/must be an exchange symbol/);
  });

  it('drops a fallback price endpoint identical to the primary', () => {
    const config = load({
      ...baseEnv,
      PRICE_API: 'https://a.test/p',
      PRICE_API_FALLBACKS: 'https://a.test/p, https://b.test/p',
    });
    expect(config.price.fallbackEndpoints).toEqual(['https://b.test/p']);
  });

  it('rejects an invalid fallback endpoint', () => {
    expect(() => load({ ...baseEnv, PRICE_API_FALLBACKS: 'nope' })).toThrow(/PRICE_API_FALLBACKS contains an invalid URL/);
  });
});

describe('normalisePrivateKey', () => {
  it('accepts a key with or without 0x and lowercases it', () => {
    expect(normalisePrivateKey(TEST_KEY.toUpperCase().replace('0X', '0x'))).toBe(TEST_KEY);
    expect(normalisePrivateKey(TEST_KEY.slice(2))).toBe(TEST_KEY);
  });

  it.each(['', '0x', 'zz', TEST_KEY + '00', TEST_KEY.slice(0, -1)])('rejects %j', (raw) => {
    expect(() => normalisePrivateKey(raw)).toThrow(ConfigError);
  });
});

describe('bnbToWei', () => {
  it('converts without float error', () => {
    expect(bnbToWei('1')).toBe(10n ** 18n);
    expect(bnbToWei('0.05')).toBe(50_000_000_000_000_000n);
    expect(bnbToWei('0.000000000000000001')).toBe(1n);
  });

  it('rejects a non-decimal amount', () => {
    expect(() => bnbToWei('1e18')).toThrow(ConfigError);
    expect(() => bnbToWei('-1')).toThrow(ConfigError);
  });
});

describe('gweiToWei', () => {
  it('scales gwei to wei', () => {
    expect(gweiToWei(1)).toBe(1_000_000_000n);
    expect(gweiToWei(0.1)).toBe(100_000_000n);
  });
});

describe('redactUrl', () => {
  it('hides an API key carried in the query string', () => {
    expect(redactUrl('https://rpc.test/v1?apikey=supersecretvalue')).toBe('https://rpc.test/v1?apikey=***');
  });

  it('hides a long API key carried in the path', () => {
    expect(redactUrl('https://rpc.test/v2/0123456789abcdef0123')).toBe('https://rpc.test/v2/***');
  });

  it('leaves a plain public endpoint readable', () => {
    expect(redactUrl('https://bsc-dataseed1.bnbchain.org/')).toBe('https://bsc-dataseed1.bnbchain.org/');
  });

  it('never throws on junk', () => {
    expect(redactUrl('not a url')).toBe('<unparseable-url>');
  });
});
