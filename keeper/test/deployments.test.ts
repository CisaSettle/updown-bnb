import { describe, expect, it } from 'vitest';
import { ConfigError, defaultDeploymentsPath, parseDeployment, RESERVED_KEYS } from '../src/deployments.js';

// The exact shape written by contracts/script/Deploy.s.sol.
const testnetFile = {
  chainId: 97,
  registry: '0x1111111111111111111111111111111111111111',
  btcUsd5m: '0x2222222222222222222222222222222222222222',
  btcUsd1h: '0x3333333333333333333333333333333333333333',
  bnbUsd5m: '0x4444444444444444444444444444444444444444',
  btcFeed: '0x5555555555555555555555555555555555555555',
  bnbFeed: '0x6666666666666666666666666666666666666666',
  usdt: '0x7777777777777777777777777777777777777777',
  owner: '0x8888888888888888888888888888888888888888',
  operator: '0x9999999999999999999999999999999999999999',
  relayFeeds: true,
  feeBps: 300,
};

describe('parseDeployment', () => {
  it('extracts exactly the three deployed markets and nothing else', () => {
    const parsed = parseDeployment(testnetFile, 97, 'testnet.json');
    expect(parsed.markets.map((m) => m.name)).toEqual(['bnbUsd5m', 'btcUsd1h', 'btcUsd5m']);
    expect(parsed.markets.map((m) => m.address)).not.toContain(testnetFile.registry);
    expect(parsed.markets.map((m) => m.address)).not.toContain(testnetFile.usdt);
  });

  it('checksums addresses', () => {
    const parsed = parseDeployment({ ...testnetFile, btcUsd5m: '0xaBcDeF0000000000000000000000000000000001' }, 97);
    const market = parsed.markets.find((m) => m.name === 'btcUsd5m');
    expect(market?.address).toBe('0xaBCdEf0000000000000000000000000000000001');
  });

  it('collects feed addresses separately from markets', () => {
    const parsed = parseDeployment(testnetFile, 97);
    expect(Object.keys(parsed.feeds).sort()).toEqual(['bnbFeed', 'btcFeed']);
  });

  it('reads relayFeeds, which switches the whole relay pipeline on', () => {
    expect(parseDeployment(testnetFile, 97).relayFeeds).toBe(true);
    expect(parseDeployment({ ...testnetFile, chainId: 56, relayFeeds: false }, 56).relayFeeds).toBe(false);
    // Absent means false: mainnet must never try to write to a Chainlink feed.
    const { relayFeeds: _omit, ...withoutFlag } = testnetFile;
    expect(parseDeployment({ ...withoutFlag, chainId: 56 }, 56).relayFeeds).toBe(false);
  });

  it('picks up a market key the deploy script has not been written yet', () => {
    const parsed = parseDeployment(
      { ...testnetFile, ethUsd5m: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      97,
    );
    expect(parsed.markets.map((m) => m.name)).toContain('ethUsd5m');
  });

  it('refuses a file for a different chain, naming both ids', () => {
    expect(() => parseDeployment(testnetFile, 56)).toThrow(/is for chainId 97 but CHAIN_ID=56/);
  });

  it('refuses a file with no markets and says what was expected', () => {
    expect(() =>
      parseDeployment({ chainId: 97, registry: testnetFile.registry, relayFeeds: true }, 97),
    ).toThrow(/contains no market addresses/);
  });

  it('refuses the same market address under two keys', () => {
    expect(() => parseDeployment({ ...testnetFile, btcUsd1h: testnetFile.btcUsd5m }, 97)).toThrow(/twice/);
  });

  it.each([null, [], 'string', 42])('refuses non-object content %j', (raw) => {
    expect(() => parseDeployment(raw, 97)).toThrow(ConfigError);
  });

  it('refuses a missing or unusable chainId', () => {
    expect(() => parseDeployment({ ...testnetFile, chainId: undefined }, 97)).toThrow(/no valid "chainId"/);
    expect(() => parseDeployment({ ...testnetFile, chainId: 'ninety-seven' }, 97)).toThrow(/no valid "chainId"/);
  });

  it('refuses a non-boolean relayFeeds rather than coercing it', () => {
    expect(() => parseDeployment({ ...testnetFile, relayFeeds: 'true' }, 97)).toThrow(/non-boolean "relayFeeds"/);
  });

  it('ignores zero addresses and non-address values', () => {
    const parsed = parseDeployment(
      {
        ...testnetFile,
        placeholder: '0x0000000000000000000000000000000000000000',
        note: 'deployed by hand',
        blockNumber: 12345,
      },
      97,
    );
    expect(parsed.markets.map((m) => m.name)).not.toContain('placeholder');
    expect(parsed.markets.map((m) => m.name)).not.toContain('note');
  });

  it('never treats a reserved key as a market, even when it holds an address', () => {
    for (const key of RESERVED_KEYS) {
      // chainId and relayFeeds carry their own type contracts; an address in either is a hard
      // error, tested above. The rest simply must never be mistaken for a market.
      if (key === 'chainId' || key === 'relayFeeds') continue;
      const parsed = parseDeployment({ ...testnetFile, [key]: testnetFile.owner }, 97);
      expect(parsed.markets.map((m) => m.name)).not.toContain(key);
    }
  });
});

describe('defaultDeploymentsPath', () => {
  it('points at contracts/deployments/<chainId>.json next to the keeper package', () => {
    expect(defaultDeploymentsPath(97, '/repo/keeper')).toBe('/repo/contracts/deployments/97.json');
    expect(defaultDeploymentsPath(56, '/repo/keeper')).toBe('/repo/contracts/deployments/56.json');
  });
});
