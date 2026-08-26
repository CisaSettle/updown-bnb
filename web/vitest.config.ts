import { defineConfig } from 'vitest/config'

/**
 * Deliberately separate from `vite.config.ts`: the app config resolves on-chain deployment
 * addresses at build time, and the unit tests here cover pure logic that must not depend on which
 * chain the bundle was built for.
 *
 * The `define`d deployment is a fixed, obviously-fake stand-in for the build-time constant, so a
 * component that transitively imports `src/config/deployment.ts` can be rendered in a test without
 * dragging a real deployment — or a real chain id — into the assertions.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  define: {
    __DEPLOYMENT__: JSON.stringify({
      chainId: 97,
      registry: '0x0000000000000000000000000000000000000001',
      btcUsd5m: '0x0000000000000000000000000000000000000002',
      btcUsd1h: '0x0000000000000000000000000000000000000003',
      bnbUsd5m: '0x0000000000000000000000000000000000000004',
      btcFeed: '0x0000000000000000000000000000000000000005',
      bnbFeed: '0x0000000000000000000000000000000000000006',
      usdt: '0x0000000000000000000000000000000000000007',
      owner: '0x0000000000000000000000000000000000000008',
      operator: '0x0000000000000000000000000000000000000009',
      relayFeeds: true,
      feeBps: 300,
    }),
    __DEPLOYMENT_META__: JSON.stringify({ source: 'test fixture', placeholder: false }),
  },
})
