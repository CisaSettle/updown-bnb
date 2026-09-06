import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import App from './App'
import { wagmiConfig } from './config/wagmi'
import { installGlobalReporters } from './lib/report'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
      // Individual reads set their own refetchInterval; this is just a floor for freshness.
      staleTime: 2_000,
    },
  },
})

// Before anything can throw: a rejected promise nobody awaited is otherwise invisible to everyone,
// including the person it happened to. No-op unless VITE_ERROR_REPORT_URL is set.
installGlobalReporters()

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
