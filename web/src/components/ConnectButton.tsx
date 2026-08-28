import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, type Connector } from 'wagmi'
import * as ui from '../content/ui'
import { addressUrl } from '../config/chains'
import { useActiveChain } from '../hooks/useActiveChain'
import { humanizeError, isRequestAlreadyPending } from '../lib/errors'
import { shortAddress } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { rovingIndex } from '../lib/roving'
import { dismissToast, pushToast } from '../lib/toast'
import { watchWalletAuthorization } from '../lib/walletWatch'
import { DEMO_WALLET_CONNECTOR_ID, forgetDemoWallet } from '../lib/demoWallet'

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

const MENU_CLASS =
  'absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900'

/**
 * The state and keyboard contract of one dropdown, shared by the account menu and the wallet
 * picker so `role="menu"` promises the same thing everywhere it is announced: focus lands on the
 * first item when the menu opens, ArrowUp/ArrowDown/Home/End move it, Escape closes and returns
 * focus to the trigger, and Tab closes WITHOUT re-grabbing focus — snapping focus back on Tab
 * would trap a keyboard user inside the header.
 */
function useMenu(itemCount: number) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const items = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) items.current[0]?.focus()
  }, [open])

  const close = useCallback((refocusTrigger: boolean) => {
    setOpen(false)
    if (refocusTrigger) trigger.current?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
      return
    }
    if (e.key === 'Tab') {
      close(false)
      return
    }
    const current = items.current.findIndex((el) => el === document.activeElement)
    const next = rovingIndex(e.key, current === -1 ? 0 : current, itemCount, 'vertical')
    if (next === undefined) return
    e.preventDefault()
    items.current[next]?.focus()
  }

  return { open, setOpen, wrapper, trigger, items, close, onKeyDown }
}

/**
 * The connected-address chip and its menu — one component for both the right-chain and the
 * wrong-chain header, so Disconnect and the explorer link cannot vanish with the network again
 * and the two states cannot drift apart in menu behaviour.
 */
function AccountMenu({ address, onDisconnect, isDemo }: { address: string; onDisconnect: () => void; isDemo: boolean }) {
  const lang = useLang()
  const { disconnect } = useDisconnect()
  const menu = useMenu(isDemo ? 3 : 2)

  return (
    <div className="relative" ref={menu.wrapper} onKeyDown={menu.onKeyDown}>
      <button
        type="button"
        ref={menu.trigger}
        className="btn-secondary"
        onClick={() => menu.setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menu.open}
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="num">{shortAddress(address)}</span>
      </button>
      {menu.open ? (
        <div role="menu" className={MENU_CLASS}>
          <a
            role="menuitem"
            ref={(el) => {
              menu.items.current[0] = el
            }}
            href={addressUrl(address)}
            target="_blank"
            rel="noreferrer"
            className="block px-4 py-3 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => menu.close(true)}
          >
            {t(lang, ui.connect.explorer)}
          </a>
          <button
            role="menuitem"
            ref={(el) => {
              menu.items.current[1] = el
            }}
            type="button"
            className="block w-full px-4 py-3 text-left text-sm text-rose-600 hover:bg-slate-100 dark:text-rose-400 dark:hover:bg-slate-800"
            onClick={() => {
              onDisconnect()
              disconnect()
              menu.close(false)
            }}
          >
            {t(lang, ui.connect.disconnect)}
          </button>
          {isDemo ? (
            <button
              role="menuitem"
              ref={(el) => {
                menu.items.current[2] = el
              }}
              type="button"
              className="block w-full border-t border-slate-200 px-4 py-3 text-left text-sm text-rose-600 hover:bg-slate-100 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-slate-800"
              onClick={() => {
                if (!window.confirm(t(lang, ui.demoWallet.removeConfirm))) return
                // Disconnect first so wagmi releases the active account; removing the only copy of
                // the key is then explicit, user-confirmed, and limited to this app's one record.
                onDisconnect()
                disconnect()
                forgetDemoWallet()
                menu.close(false)
              }}
            >
              {t(lang, ui.demoWallet.remove)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ConnectButton() {
  const lang = useLang()
  const { address, isConnected, connector: activeConnector } = useAccount()
  const { wrongChain, isSwitching, switchToActiveChain } = useActiveChain()
  const { connectors, connect, isPending } = useConnect()

  // The header slot swaps its control when the connection state flips, and the browser drops
  // focus to <body> when the focused element unmounts. Focus moves to the replacement ONLY when
  // the flip was caused by an action inside this component — an automatic reconnect must never
  // steal focus from wherever the user is working.
  const root = useRef<HTMLDivElement>(null)
  const focusNext = useRef(false)
  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    root.current?.querySelector('button')?.focus()
  }, [isConnected])

  // The recovery from "your wallet already has a request open" (-32002): the page cannot cancel
  // the wallet's queued popup, so it watches for the moment the user deals with it and then
  // finishes the connection itself — with whichever account the wallet has selected by then.
  // Without this, every further click fails with the same code and the page reads as broken.
  const pendingWatch = useRef<{ stop: () => void; toastId: number } | null>(null)

  const clearPendingWatch = useCallback(() => {
    if (pendingWatch.current === null) return
    pendingWatch.current.stop()
    dismissToast(pendingWatch.current.toastId)
    pendingWatch.current = null
  }, [])

  // The other half of the same failure: the FIRST click. The popup opens behind the browser
  // window, the mutation just stays pending, and the button reads a disabled "Connecting…"
  // forever — no error fires, so the -32002 path above never gets its chance. After a few
  // seconds of silence the page says out loud where the popup is.
  const slowConnect = useRef<{ timer: number; toastId: number | null } | null>(null)

  const clearSlowConnect = useCallback(() => {
    if (slowConnect.current === null) return
    window.clearTimeout(slowConnect.current.timer)
    if (slowConnect.current.toastId !== null) dismissToast(slowConnect.current.toastId)
    slowConnect.current = null
  }, [])

  useEffect(() => clearPendingWatch, [clearPendingWatch])
  useEffect(() => clearSlowConnect, [clearSlowConnect])
  useEffect(() => {
    // However the connection completes — this watch, a fresh click, the wallet's own initiative —
    // the "deal with your wallet" toast is out of date the moment it does.
    if (isConnected) {
      clearPendingWatch()
      clearSlowConnect()
    }
  }, [isConnected, clearPendingWatch, clearSlowConnect])

  function beginPendingWatch(connector: Connector) {
    clearPendingWatch()
    const toastId = pushToast({
      kind: 'info',
      title: t(lang, ui.connect.walletWaiting),
      body: t(lang, ui.connect.walletWaitingBody),
      timeout: 0,
    })
    const stop = watchWalletAuthorization(
      () => connector.getProvider(),
      () => {
        // The queued request has been dealt with and an account is authorised, so this connect
        // resolves silently — a wallet only pops up when it has something left to ask.
        clearPendingWatch()
        doConnect(connector)
      },
    )
    pendingWatch.current = { stop, toastId }
  }

  function doConnect(connector: Connector) {
    // A fresh attempt supersedes any watch from an earlier one: leaving the old watch running
    // would let it fire `doConnect` again mid-attempt and stack a second connect cycle.
    clearPendingWatch()
    focusNext.current = true
    clearSlowConnect()
    const timer = window.setTimeout(() => {
      if (slowConnect.current === null) return
      slowConnect.current.toastId = pushToast({
        kind: 'info',
        title: t(lang, ui.connect.walletWaiting),
        body: t(lang, ui.connect.walletWaitingBody),
        timeout: 0,
      })
    }, 4_000)
    slowConnect.current = { timer, toastId: null }
    connect(
      { connector },
      {
        onSettled: () => clearSlowConnect(),
        onSuccess: () => clearPendingWatch(),
        onError: (err) => {
          // The attempt did not connect, so its claim on focus dies with it — otherwise a later
          // AUTOMATIC reconnect would consume the stale flag and steal focus from wherever the
          // user has moved on to.
          focusNext.current = false
          if (isRequestAlreadyPending(err)) {
            beginPendingWatch(connector)
            return
          }
          pushToast({ kind: 'error', title: t(lang, ui.connect.failed), body: humanizeError(err, lang) })
        },
      },
    )
  }

  const markUserDisconnect = () => {
    focusNext.current = true
  }

  const injectedAvailable = hasInjectedProvider()
  const usable = connectors.filter((c) => c.type !== 'injected' || injectedAvailable)
  const pickerMenu = useMenu(usable.length)

  let content: React.ReactNode

  if (wrongChain) {
    // The switch button is the loud thing, but the account is still the user's: Disconnect and
    // the explorer link stay reachable instead of vanishing with the network.
    content = (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn bg-amber-500 text-amber-950 hover:bg-amber-400"
          disabled={isSwitching}
          onClick={switchToActiveChain}
        >
          {t(lang, isSwitching ? ui.connect.switching : ui.switchNetwork(lang))}
        </button>
        {isConnected && address ? (
          <AccountMenu address={address} onDisconnect={markUserDisconnect} isDemo={activeConnector?.id === DEMO_WALLET_CONNECTOR_ID} />
        ) : null}
      </div>
    )
  } else if (isConnected && address) {
    content = (
      <AccountMenu address={address} onDisconnect={markUserDisconnect} isDemo={activeConnector?.id === DEMO_WALLET_CONNECTOR_ID} />
    )
  } else {
    if (usable.length === 0) {
      const deepLink = walletDeepLink()
      content = deepLink ? (
        // The label says what the tap actually does — leave this browser for the wallet app. This
        // branch only ever renders on phones, where the `title` explanation can never show, so a
        // "Connect wallet" label here promised a dialog and delivered a navigation.
        <a className="btn-primary" href={deepLink} title={t(lang, ui.connect.openInWalletHint)}>
          {t(lang, ui.connect.openInWallet)}
        </a>
      ) : (
        <a className="btn-primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          {t(lang, ui.connect.installWallet)}
        </a>
      )
    } else if (usable.length === 1 && usable[0]) {
      const only = usable[0]
      content = (
        <button type="button" className="btn-primary" disabled={isPending} onClick={() => doConnect(only)}>
          {t(lang, isPending ? ui.connect.connecting : ui.connect.connect)}
        </button>
      )
    } else {
      content = (
        <div className="relative" ref={pickerMenu.wrapper} onKeyDown={pickerMenu.onKeyDown}>
          <button
            type="button"
            ref={pickerMenu.trigger}
            className="btn-primary"
            onClick={() => pickerMenu.setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={pickerMenu.open}
            disabled={isPending}
          >
            {t(lang, isPending ? ui.connect.connecting : ui.connect.connect)}
          </button>
          {pickerMenu.open ? (
            <div role="menu" className={MENU_CLASS}>
              {usable.map((c, i) => (
                <button
                  key={c.uid}
                  role="menuitem"
                  ref={(el) => {
                    pickerMenu.items.current[i] = el
                  }}
                  type="button"
                  className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => {
                    pickerMenu.close(false)
                    doConnect(c)
                  }}
                >
                  {c.id === DEMO_WALLET_CONNECTOR_ID ? t(lang, ui.demoWallet.connectorName) : c.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )
    }
  }

  return <div ref={root}>{content}</div>
}
