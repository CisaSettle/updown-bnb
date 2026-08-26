import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Hex,
} from 'viem'
import { allErrorsAbi } from '../abi'
import { t, type Lang, type Text } from './i18n'

/**
 * Human copy for every custom error the protocol can revert with. A user must never see a raw
 * selector or a hex blob, so anything we cannot name falls through to a plain-language default.
 *
 * Every message says what happened and what to do next, in both languages. The 中文 is held to the
 * same standard as the English: a revert is not an 操作失败, a void is not a 错误, and a round that
 * is not yours to collect says so rather than apologising. `Record<string, Text>` is what makes a
 * half-translated entry a compile error instead of an English sentence in front of a 中文 reader.
 */
export const ERROR_COPY: Record<string, Text> = {
  // ── betting ──
  NotBettable: {
    en: 'Betting on this round has closed. Place your bet on the next round.',
    zh: '这一轮已经停止下注。到下一轮再下。',
  },
  WrongEpoch: {
    en: 'That round moved on while you were signing. Try again on the current round.',
    zh: '你签名的时候那一轮已经过去了。在当前这一轮重新下注。',
  },
  BelowMinBet: {
    en: 'That is below the minimum bet for this market.',
    zh: '这个金额低于本市场的最小下注额。',
  },
  AboveMaxBet: {
    en: 'That is above the maximum bet allowed per transaction.',
    zh: '这个金额超过了单笔交易允许的最大下注额。',
  },
  SideCapExceeded: {
    en: 'This side of the round has hit its size cap. Try a smaller amount or the other side.',
    zh: '本轮这一边已经打满单边上限。换个小一点的金额，或者押另一边。',
  },
  NotStarted: {
    en: 'This market has not opened its first round yet.',
    zh: '这个市场还没有开出第一轮。',
  },
  ValueMismatch: {
    en: 'The amount sent did not match the amount requested. Try again.',
    zh: '实际发送的金额和请求的金额对不上。重试一次。',
  },
  UnsupportedAsset: {
    en: 'This market cannot accept that token (it takes a fee on transfer or rebases).',
    zh: '这个市场不能收这种代币（它转账抽税，或者会 rebase）。',
  },

  // ── claiming ──
  AlreadyClaimed: {
    en: 'You have already collected that round.',
    zh: '那一轮你已经领过了。',
  },
  // Not "you lost": `claim` reverts with this for anyone the round does not owe, including a
  // wallet that never bet in it. 押错 would state a bet that may not exist.
  NotWinner: {
    en: 'That round is not a winning round for you, so there is nothing to collect.',
    zh: '那一轮你不是赢家，所以没有可领的钱。',
  },
  // A round becomes collectable when it settles — or, if nobody ever settles it, when its own
  // settlement window elapses and it turns refundable. Both routes are named, because the second
  // is the one that matters when a keeper has stalled.
  NotResolved: {
    en: 'That round has not been settled yet. It becomes collectable once it settles — or, if it never does, once its settlement window has elapsed.',
    zh: '那一轮还没有结算。结算之后就能领；如果始终没有人结算，等它的结算时限过去，它会转为可退款。',
  },
  NothingToClaim: {
    en: 'There is nothing to collect right now.',
    zh: '现在没有可领的钱。',
  },
  EmptyInput: {
    en: 'Nothing was selected to collect.',
    zh: '没有选中任何要领取的轮次。',
  },

  // ── round engine ──
  TooEarly: {
    en: 'It is too early to settle this round.',
    zh: '现在结算这一轮还太早。',
  },
  AlreadyStarted: {
    en: 'This market has already started.',
    zh: '这个市场已经开启过了。',
  },
  TimestampOverflow: {
    en: 'The round schedule is out of range.',
    zh: '轮次的时间安排超出了可表示的范围。',
  },

  // ── plumbing ──
  TransferFailed: {
    en: 'The transfer failed. Check your balance and try again.',
    zh: '转账没有成功。检查一下余额再试。',
  },
  CannotRecoverAsset: {
    en: 'That asset cannot be recovered from this market.',
    zh: '这个资产没法从这个市场里取回。',
  },
  ZeroAddress: {
    en: 'A required address was empty.',
    zh: '有一个必填的地址是空的。',
  },
  ReentrancyGuardReentrantCall: {
    en: 'That call was rejected as re-entrant.',
    zh: '这次调用因为重入被拒绝了。',
  },
  // A pause stops the market taking NEW risk; it does not cancel risk already taken. A round that
  // had already locked still settles, through the pause, at its true price — `executeRound` is not
  // pausable. Only a round that never received a strike runs out its window and refunds.
  EnforcedPause: {
    en: 'This market is paused, so no new bets are accepted. A round that has already locked still settles normally; one that had not locked becomes fully refundable — no fee is taken.',
    zh: '这个市场已暂停，不再接受新的下注。已经锁定的轮次仍会照常结算；还没锁定的轮次转为全额可退——不收手续费。',
  },
  ExpectedPause: {
    en: 'This market is not paused.',
    zh: '这个市场并没有处于暂停状态。',
  },

  // ── access / admin ──
  OwnableUnauthorizedAccount: {
    en: 'Only the market owner can do that.',
    zh: '只有市场的管理员才能这么做。',
  },
  OwnableInvalidOwner: {
    en: 'Invalid owner address.',
    zh: '管理员地址无效。',
  },
  InvalidBoundaryProof: {
    en: 'The settlement price for this round could not be proved yet. Anyone can settle it — including you — once the price feed has published at or before the round boundary.',
    zh: '本轮的结算价现在还证明不出来。等喂价在轮次边界时刻或之前发布了报价，任何人——包括你——都可以来结算它。',
  },
  NotUpdater: {
    en: 'Only the price relay updater can push a price.',
    zh: '只有价格中继的更新者才能推送价格。',
  },
  NoData: {
    en: 'The price feed has no data for that round.',
    zh: '喂价里没有那一轮的数据。',
  },
  BadAnswer: {
    en: 'The price feed rejected that value.',
    zh: '喂价拒绝了这个数值。',
  },

  // ── config ──
  InvalidFee: { en: 'Invalid fee setting.', zh: '手续费设置无效。' },
  InvalidBuffer: { en: 'Invalid settlement buffer setting.', zh: '结算时限设置无效。' },
  InvalidInterval: { en: 'Invalid round interval.', zh: '轮次间隔设置无效。' },
  InvalidOracleMaxAge: { en: 'Invalid oracle staleness setting.', zh: '预言机滞后上限设置无效。' },
  InvalidLimits: { en: 'Invalid bet limits.', zh: '下注限额设置无效。' },

  // ── registry ──
  AlreadyRegistered: { en: 'That market is already registered.', zh: '这个市场已经注册过了。' },
  UnknownMarket: { en: 'That market is not in the registry.', zh: '注册表里没有这个市场。' },

  // ── ERC20 ──
  ERC20InsufficientBalance: {
    en: 'Your token balance is too low for this amount.',
    zh: '你的代币余额不够这个金额。',
  },
  ERC20InsufficientAllowance: {
    en: 'The market is not approved to move that much. Approve first, then bet.',
    zh: '市场的授权额度不够动这么多钱。先授权，再下注。',
  },
  ERC20InvalidReceiver: { en: 'Invalid recipient address.', zh: '收款地址无效。' },
  ERC20InvalidSpender: { en: 'Invalid spender address.', zh: '被授权方地址无效。' },
  ERC20InvalidApprover: { en: 'Invalid approver address.', zh: '授权方地址无效。' },
  ERC20InvalidSender: { en: 'Invalid sender address.', zh: '发送方地址无效。' },
  SafeERC20FailedOperation: {
    en: 'The token transfer was rejected by the token contract.',
    zh: '代币合约拒绝了这次转账。',
  },
}

/** The copy that is not keyed by a custom error name, kept together so it can be tested as a set. */
export const ERROR_TEXT = {
  fallback: { en: 'Something went wrong. Please try again.', zh: '出了点问题，重试一次。' },
  rejected: { en: 'You rejected the request in your wallet.', zh: '你在钱包里拒绝了这个请求。' },
  requestPending: {
    en: 'Your wallet already has a request waiting. Open the wallet, deal with that one, then try again.',
    zh: '你的钱包里已经有一个请求在等着了。打开钱包处理完那一个，再回来重试。',
  },
  alreadyConnected: {
    en: 'That wallet is already connected.',
    zh: '这个钱包已经连上了。',
  },
  noProvider: {
    en: 'No wallet answered. If you have more than one extension installed, they can fight over the page — disable the ones you are not using and reload.',
    zh: '没有钱包应答。如果你装了不止一个钱包插件，它们会互相抢这个页面——把用不到的停用后刷新页面再试。',
  },
  unnamedRevert: { en: 'The contract rejected this transaction.', zh: '合约拒绝了这笔交易。' },
  noGas: {
    en: 'Not enough gas balance in your wallet to send this transaction.',
    zh: '钱包里的余额不够付这笔交易的 gas。',
  },
  wrongChain: {
    en: 'Your wallet is on a different network. Switch network and try again.',
    zh: '你的钱包在另一条网络上。切换网络后重试。',
  },
  timeout: {
    en: 'The network request timed out. Check your connection and try again.',
    zh: '网络请求超时。检查一下网络连接再试。',
  },
  disconnected: {
    en: 'Wallet disconnected. Connect your wallet and try again.',
    zh: '钱包已断开。连接钱包后重试。',
  },
  faucetCooldown: {
    en: 'The faucet is cooling down. Try again a little later.',
    zh: '水龙头在冷却中，过一会儿再来。',
  },
  reverted: {
    en: 'The contract would reject this transaction. Reload the round and try again.',
    zh: '这笔交易会被合约拒绝。刷新一下轮次再试。',
  },
  rpc: {
    en: 'The node rejected the request. Try again in a moment.',
    zh: '节点拒绝了这次请求，过一会儿再试。',
  },
  network: {
    en: 'Could not reach the network. Check your connection and try again.',
    zh: '连不上网络。检查一下网络连接再试。',
  },
  nonce: {
    en: 'Your wallet and the node disagree on this account’s nonce. Reload the page and try again.',
    zh: '钱包和节点对这个账户的 nonce 说法不一致。刷新页面再试。',
  },
} satisfies Record<string, Text>

const HEXY = /0x[0-9a-fA-F]{8,}/
const NETWORKY = /fetch failed|failed to fetch|http request failed|network (?:error|request)|econnrefused|load failed/
const RPCY = /rpc|internal (?:json-)?rpc error|invalid json|method not found|-32\d\d\d/

/**
 * What to show when nothing in the table matched.
 *
 * viem's `shortMessage` is not text the chain wrote — it is viem's own English UI copy — so it is
 * not ours to put in front of a 中文 reader at the one moment their money did not move. English
 * keeps it, because for that reader it says strictly more than the generic line; 中文 gets the
 * generic line, which at least it can read. (A revert `reason` string is different and is still
 * passed through in both languages: that one really was written on chain, and inventing a 中文
 * rendering of it would be putting words in the contract's mouth.)
 */
function passthrough(raw: string, lang: Lang, fallback: Text): Text {
  if (lang !== 'en') return fallback
  if (!raw || HEXY.test(raw)) return fallback
  return { en: raw, zh: fallback.zh }
}

/**
 * A JSON-RPC error code, if the error carries one.
 *
 * A 中文 reader is never handed a library's English sentence — that rule stands. But the fallback
 * on its own destroys the only fact that would let anyone act: it says "something went wrong" and
 * sends the reader round the same loop. A numeric code is not prose in anyone's language, so it can
 * be shown to both without mixing them, and it is the first thing a person is asked for when they
 * come for help. `-32002` in particular is the difference between "this app is broken" and "your
 * wallet is waiting for you behind this window".
 */
function rpcCode(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 6) return undefined
  const e = err as { code?: unknown; cause?: unknown }
  if (typeof e.code === 'number' && Number.isInteger(e.code)) return e.code
  return rpcCode(e.cause, depth + 1)
}

/** The fallback, plus the error's code where it has one. */
function fallbackWithCode(err: unknown, lang: Lang, fallback: Text): string {
  const code = rpcCode(err)
  if (code === undefined) return t(lang, fallback)
  const en = `${fallback.en.replace(/\s*$/, '')} (code ${code})`
  const zh = `${fallback.zh.replace(/[。.]\s*$/, '')}（错误码 ${code}）。`
  return t(lang, { en, zh })
}

/**
 * `FaucetCooldown(availableAt)` carries the second the faucet reopens, so the copy can say when to
 * come back rather than \"later\". English pluralises the minute; 中文 does not inflect, and both
 * round the same way so the two languages never quote different waits.
 */
export function faucetCooldownCopy(args: readonly unknown[] | undefined, nowSeconds = Date.now() / 1000): Text {
  const availableAt = typeof args?.[0] === 'bigint' ? Number(args[0]) : undefined
  if (!availableAt) return ERROR_TEXT.faucetCooldown
  const secs = Math.max(0, availableAt - Math.floor(nowSeconds))
  const mins = Math.ceil(secs / 60)
  return {
    en: `The faucet is cooling down. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`,
    zh: `水龙头在冷却中，大约 ${mins} 分钟后再来。`,
  }
}

/** The copy for a named custom error, in both languages. Unknown names get the plain default. */
export function errorCopy(name: string, args?: readonly unknown[]): Text {
  if (name === 'FaucetCooldown') return faucetCooldownCopy(args)
  return ERROR_COPY[name] ?? ERROR_TEXT.unnamedRevert
}

function decodeRaw(raw: Hex | undefined): { name: string; args?: readonly unknown[] } | undefined {
  if (!raw || raw === '0x') return undefined
  try {
    const decoded = decodeErrorResult({ abi: allErrorsAbi, data: raw })
    return { name: decoded.errorName, args: decoded.args as readonly unknown[] | undefined }
  } catch {
    return undefined
  }
}

/** Every message in the cause chain, lower-cased, so a wrapped error is not invisible. */
function messageChain(err: unknown, depth = 0): string {
  if (!err || depth > 6) return ''
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err !== 'object') return ''
  const e = err as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown }
  const own = [e.shortMessage, e.message, e.details].filter((x) => typeof x === 'string').join(' ')
  return `${own} ${messageChain(e.cause, depth + 1)}`.toLowerCase()
}

/**
 * The wallet-connection failures worth naming, recognised on the error's *shape-independent*
 * evidence: its JSON-RPC code, and the messages anywhere in its cause chain.
 *
 * These used to be classified inside the `BaseError` branch, which meant they only worked when
 * viem had wrapped the error. A wallet rejecting a connect request often throws a plain object or
 * an `Error` with the provider error tucked into `cause`, and those fell through to the generic
 * fallback — the exact case that sent the owner round the loop with "something went wrong".
 */
function connectorCopy(err: unknown): Text | undefined {
  const code = rpcCode(err)
  const text = messageChain(err)
  // -32002: a request is already open in the wallet. The popup is usually behind the browser
  // window, so to the person nothing happened and clicking again is the natural move — which is
  // precisely what produces this. Naming it is the difference between "the app is broken" and
  // "your wallet is waiting for you".
  if (code === -32002 || text.includes('already pending') || text.includes('already processing')) {
    return ERROR_TEXT.requestPending
  }
  if (text.includes('already connected')) return ERROR_TEXT.alreadyConnected
  if (text.includes('provider not found') || text.includes('no injected provider')) {
    return ERROR_TEXT.noProvider
  }
  return undefined
}

function looksLikeRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true
  const anyErr = err as { code?: unknown; name?: unknown; message?: unknown }
  if (anyErr?.code === 4001) return true
  if (typeof anyErr?.name === 'string' && anyErr.name === 'UserRejectedRequestError') return true
  const msg = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : ''
  return msg.includes('user rejected') || msg.includes('user denied')
}

/** Best-effort name of the custom error behind a failure, or `undefined`. */
export function errorName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined
  if (reverted.data?.errorName) return reverted.data.errorName
  return decodeRaw(reverted.raw)?.name
}

/**
 * Turns any wallet / RPC / contract failure into one sentence a trader can act on, in the language
 * they are reading. Never returns a hex string.
 *
 * `lang` is a required argument rather than a defaulted one: a call site that forgot it would ship
 * English to a 中文 reader at exactly the moment their money did not move, and that has to be a
 * compile error.
 *
 * The two escape hatches — a revert `reason` string and viem's `shortMessage` — are passed through
 * untranslated in both languages. They are text the chain or the wallet wrote, and inventing a
 * 中文 rendering of a string we did not author would be putting words in their mouth.
 */
export function humanizeError(err: unknown, lang: Lang, fallback: Text = ERROR_TEXT.fallback): string {
  if (!err) return t(lang, fallback)
  if (looksLikeRejection(err)) return t(lang, ERROR_TEXT.rejected)
  // Whatever we end up showing, the original survives somewhere a person can go and read it. An
  // error we could not classify is precisely the one worth having the full text of.
  if (typeof console !== 'undefined') console.warn('[updown] unhandled error surfaced to the user:', err)

  const connector = connectorCopy(err)
  if (connector) return t(lang, connector)

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const named = reverted.data?.errorName
        ? { name: reverted.data.errorName, args: reverted.data.args as readonly unknown[] | undefined }
        : decodeRaw(reverted.raw)
      if (named) return t(lang, errorCopy(named.name, named.args))
      if (reverted.reason && !HEXY.test(reverted.reason)) return reverted.reason
      return t(lang, ERROR_TEXT.unnamedRevert)
    }

    const short = err.shortMessage || err.message || ''
    const lower = short.toLowerCase()
    if (lower.includes('insufficient funds')) return t(lang, ERROR_TEXT.noGas)
    if (lower.includes('chain') && lower.includes('mismatch')) return t(lang, ERROR_TEXT.wrongChain)
    if (lower.includes('timed out') || lower.includes('timeout')) return t(lang, ERROR_TEXT.timeout)
    if (lower.includes('connector not connected') || lower.includes('no connector')) {
      return t(lang, ERROR_TEXT.disconnected)
    }
    if (lower.includes('execution reverted')) return t(lang, ERROR_TEXT.reverted)
    if (lower.includes('nonce')) return t(lang, ERROR_TEXT.nonce)
    if (NETWORKY.test(lower)) return t(lang, ERROR_TEXT.network)
    if (RPCY.test(lower)) return t(lang, ERROR_TEXT.rpc)
    const spoken = passthrough(short, lang, fallback)
    return spoken === fallback ? fallbackWithCode(err, lang, fallback) : t(lang, spoken)
  }

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (message.length < 220) {
    const spoken = passthrough(message, lang, fallback)
    if (spoken !== fallback) return t(lang, spoken)
  }
  return fallbackWithCode(err, lang, fallback)
}
