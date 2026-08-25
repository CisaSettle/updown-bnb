import { useEffect, useRef, useState } from 'react'
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { activeChain, addressUrl } from '../config/chains'
import { humanizeError } from '../lib/errors'
import { shortAddress } from '../lib/format'
import { pushToast } from '../lib/toast'

function hasInjectedProvider(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean((window as unknown as { ethereum?: unknown }).ethereum)
}

export function ConnectButton() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const wrongNetwork = isConnected && chainId !== activeChain.id

  if (isConnected && wrongNetwork) {
    return (
      <button
        type="button"
        className="btn bg-amber-500 text-amber-950 hover:bg-amber-400"
        disabled={isSwitching}
        onClick={() =>
          switchChain(
            { chainId: activeChain.id },
            { onError: (err) => pushToast({ kind: 'error', title: 'Could not switch network', body: humanizeError(err) }) },
          )
        }
      >
        {isSwitching ? 'Switching…' : `Switch to ${activeChain.name}`}
      </button>
    )
  }

  if (isConnected && address) {
    return (
      <div className="relative" ref={wrapper}>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="num">{shortAddress(address)}</span>
        </button>
        {open ? (
          <div
            role="menu"
            className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <a
              role="menuitem"
              href={addressUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="block px-4 py-3 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => setOpen(false)}
            >
              View on explorer ↗
            </a>
            <button
              role="menuitem"
              type="button"
              className="block w-full px-4 py-3 text-left text-sm text-rose-600 hover:bg-slate-100 dark:text-rose-400 dark:hover:bg-slate-800"
              onClick={() => {
                disconnect()
                setOpen(false)
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const injectedAvailable = hasInjectedProvider()
  const usable = connectors.filter((c) => c.type !== 'injected' || injectedAvailable)

  if (usable.length === 0) {
    return (
      <a className="btn-primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        Install a wallet
      </a>
    )
  }

  if (usable.length === 1) {
    const only = usable[0]
    if (!only) return null
    return (
      <button
        type="button"
        className="btn-primary"
        disabled={isPending}
        onClick={() =>
          connect(
            { connector: only },
            { onError: (err) => pushToast({ kind: 'error', title: 'Could not connect', body: humanizeError(err) }) },
          )
        }
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }

  return (
    <div className="relative" ref={wrapper}>
      <button
        type="button"
        className="btn-primary"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isPending}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {usable.map((c) => (
            <button
              key={c.uid}
              role="menuitem"
              type="button"
              className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => {
                setOpen(false)
                connect(
                  { connector: c },
                  { onError: (err) => pushToast({ kind: 'error', title: 'Could not connect', body: humanizeError(err) }) },
                )
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
