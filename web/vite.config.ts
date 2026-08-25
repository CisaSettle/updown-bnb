import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolveDeployment, describeResolution } from './scripts/deployment.mjs'

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') } as Record<string, string | undefined>

  let resolution
  try {
    resolution = resolveDeployment(env)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`\n\n  UpDown web build failed while resolving contract addresses:\n\n  ${message}\n`)
  }

  // eslint-disable-next-line no-console
  console.log(`[updown] deployment ${describeResolution(resolution)}`)
  if (resolution.placeholder) {
    // eslint-disable-next-line no-console
    console.warn(
      '[updown] WARNING: building against PLACEHOLDER (zero) addresses.\n' +
        '         The UI will render a setup screen instead of markets.\n' +
        '         Deploy the contracts, then rebuild so contracts/deployments/<chainId>.json is picked up.\n' +
        '         Set STRICT_DEPLOYMENT=1 to make this a hard build failure.',
    )
  }

  return {
    plugins: [react()],
    define: {
      __DEPLOYMENT__: JSON.stringify(resolution.deployment),
      __DEPLOYMENT_META__: JSON.stringify({
        source: resolution.source,
        placeholder: resolution.placeholder,
      }),
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 1600,
    },
    server: { port: 5173 },
    preview: { port: 4173 },
  }
})
