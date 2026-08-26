import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import * as ui from '../content/ui'
import { addressUrl } from '../config/chains'
import { useActiveChain } from '../hooks/useActiveChain'
import { humanizeError } from '../lib/errors'
import { shortAddress } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { pushToast } from '../lib/toast'

function hasInjectedProvider(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean((window as unknown as { ethereum?: unknown }).ethereum)
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent)
}

/**
 * A phone browser never injects a provider, however many wallet apps are installed — the provider
 * only exists inside the wallet's own browser. So the honest offer on a phone is not "install a
 * wallet" (they probably have one) but "reopen this page where a wallet can reach it".
 */
function walletDeepLink(): string | null {
  if (typeof window === 'undefined' || !isMobile()) return null
  const { host, pathname, search, hash } = window.location
  return `https://metamask.app.link/dapp/${host}${pathname}${search}${hash}`
}

export function ConnectButton() {
  const lang = useLang()
  const { address, isConnected } = useAccount()
  const { wrongChain, isSwitching, switchToActiveChain } = useActiveChain()
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
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

  if (wrongChain) {
    return (
      <button
        type="button"
        className="btn bg-amber-500 text-amber-950 hover:bg-amber-400"
        disabled={isSwitching}
        onClick={switchToActiveChain}
      >
        {t(lang, isSwitching ? ui.connect.switching : ui.switchNetwork(lang))}
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
              {t(lang, ui.connect.explorer)}
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
              {t(lang, ui.connect.disconnect)}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const injectedAvailable = hasInjectedProvider()
  const usable = connectors.filter((c) => c.type !== 'injected' || injectedAvailable)

  if (usable.length === 0) {
    const deepLink = walletDeepLink()
    if (deepLink) {
      return (
        <a className="btn-primary" href={deepLink} title={t(lang, ui.connect.openInWalletHint)}>
          {t(lang, ui.connect.connect)}
        </a>
      )
    }
    return (
      <a className="btn-primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        {t(lang, ui.connect.installWallet)}
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
            {
              onError: (err) =>
                pushToast({ kind: 'error', title: t(lang, ui.connect.failed), body: humanizeError(err, lang) }),
            },
          )
        }
      >
        {t(lang, isPending ? ui.connect.connecting : ui.connect.connect)}
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
        {t(lang, isPending ? ui.connect.connecting : ui.connect.connect)}
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
                  {
                    onError: (err) =>
                      pushToast({ kind: 'error', title: t(lang, ui.connect.failed), body: humanizeError(err, lang) }),
                  },
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
