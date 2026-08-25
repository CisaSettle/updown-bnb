import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Hex,
} from 'viem'
import { allErrorsAbi } from '../abi'

/**
 * Human copy for every custom error the protocol can revert with. A user must never see a raw
 * selector or a hex blob, so anything we cannot name falls through to a plain-language default.
 */
const ERROR_COPY: Record<string, string> = {
  // ── betting ──
  NotBettable: 'Betting on this round has closed. Place your bet on the next round.',
  WrongEpoch: 'That round moved on while you were signing. Try again on the current round.',
  BelowMinBet: 'That is below the minimum bet for this market.',
  AboveMaxBet: 'That is above the maximum bet allowed per transaction.',
  SideCapExceeded: 'This side of the round has hit its size cap. Try a smaller amount or the other side.',
  NotStarted: 'This market has not opened its first round yet.',
  ValueMismatch: 'The amount sent did not match the amount requested. Try again.',
  UnsupportedAsset: 'This market cannot accept that token (it takes a fee on transfer or rebases).',

  // ── claiming ──
  AlreadyClaimed: 'You have already collected that round.',
  NotWinner: 'That round is not a winning round for you, so there is nothing to collect.',
  NotResolved: 'That round has not been settled yet. It will become collectable once it closes.',
  NothingToClaim: 'There is nothing to collect right now.',
  EmptyInput: 'Nothing was selected to collect.',

  // ── round engine ──
  TooEarly: 'It is too early to settle this round.',
  AlreadyStarted: 'This market has already started.',
  TimestampOverflow: 'The round schedule is out of range.',

  // ── plumbing ──
  TransferFailed: 'The transfer failed. Check your balance and try again.',
  CannotRecoverAsset: 'That asset cannot be recovered from this market.',
  ZeroAddress: 'A required address was empty.',
  ReentrancyGuardReentrantCall: 'That call was rejected as re-entrant.',
  EnforcedPause: 'This market is paused. Existing rounds become fully refundable — no fee is taken.',
  ExpectedPause: 'This market is not paused.',

  // ── access / admin ──
  OwnableUnauthorizedAccount: 'Only the market owner can do that.',
  OwnableInvalidOwner: 'Invalid owner address.',
  NotOperator: 'Only the keeper can settle a round this early. Anyone may settle it once the buffer passes.',
  NotUpdater: 'Only the price relay updater can push a price.',
  BadAnswer: 'The price feed rejected that value.',

  // ── config ──
  InvalidFee: 'Invalid fee setting.',
  InvalidBuffer: 'Invalid settlement buffer setting.',
  InvalidInterval: 'Invalid round interval.',
  InvalidOracleMaxAge: 'Invalid oracle staleness setting.',
  InvalidLimits: 'Invalid bet limits.',

  // ── registry ──
  AlreadyRegistered: 'That market is already registered.',
  UnknownMarket: 'That market is not in the registry.',

  // ── ERC20 ──
  ERC20InsufficientBalance: 'Your token balance is too low for this amount.',
  ERC20InsufficientAllowance: 'The market is not approved to move that much. Approve first, then bet.',
  ERC20InvalidReceiver: 'Invalid recipient address.',
  ERC20InvalidSpender: 'Invalid spender address.',
  ERC20InvalidApprover: 'Invalid approver address.',
  ERC20InvalidSender: 'Invalid sender address.',
  SafeERC20FailedOperation: 'The token transfer was rejected by the token contract.',
}

const HEXY = /0x[0-9a-fA-F]{8,}/

function faucetCooldownCopy(args: readonly unknown[] | undefined): string {
  const availableAt = typeof args?.[0] === 'bigint' ? Number(args[0]) : undefined
  if (!availableAt) return 'The faucet is cooling down. Try again a little later.'
  const secs = Math.max(0, availableAt - Math.floor(Date.now() / 1000))
  const mins = Math.ceil(secs / 60)
  return `The faucet is cooling down. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
}

function copyFor(name: string, args?: readonly unknown[]): string {
  if (name === 'FaucetCooldown') return faucetCooldownCopy(args)
  return ERROR_COPY[name] ?? 'The contract rejected this transaction.'
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
 * Turns any wallet / RPC / contract failure into one sentence a trader can act on.
 * Never returns a hex string.
 */
export function humanizeError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!err) return fallback
  if (looksLikeRejection(err)) return 'You rejected the request in your wallet.'

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const named = reverted.data?.errorName
        ? { name: reverted.data.errorName, args: reverted.data.args as readonly unknown[] | undefined }
        : decodeRaw(reverted.raw)
      if (named) return copyFor(named.name, named.args)
      if (reverted.reason && !HEXY.test(reverted.reason)) return reverted.reason
      return 'The contract rejected this transaction.'
    }

    const short = err.shortMessage || err.message || ''
    const lower = short.toLowerCase()
    if (lower.includes('insufficient funds')) {
      return 'Not enough gas balance in your wallet to send this transaction.'
    }
    if (lower.includes('chain') && lower.includes('mismatch')) {
      return 'Your wallet is on a different network. Switch network and try again.'
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return 'The network request timed out. Check your connection and try again.'
    }
    if (lower.includes('connector not connected') || lower.includes('no connector')) {
      return 'Wallet disconnected. Connect your wallet and try again.'
    }
    if (short && !HEXY.test(short)) return short
    return fallback
  }

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (message && !HEXY.test(message) && message.length < 220) return message
  return fallback
}
