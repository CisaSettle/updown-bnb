import { defineConfig } from 'vitest/config'

/**
 * Deliberately separate from `vite.config.ts`: the app config resolves on-chain deployment
 * addresses at build time, and the unit tests here cover pure logic that must not depend on which
 * chain the bundle was built for.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
