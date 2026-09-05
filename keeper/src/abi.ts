/**
 * Minimal, hand-pinned ABI fragments for the contracts the keeper touches.
 *
 * Inlined so the keeper builds and ships as a
 * standalone container, and so viem infers exact return types from the `as const` literals.
 *
 * Transcribed from the current compiler output of `contracts/src/UpDownMarketBase.sol`,
 * `UpDownRegistry.sol` and `contracts/src/testnet/RelayAggregator.sol`.
 */

/** The `Round` struct returned by `getRound(uint256)`. */
export const roundStructComponents = [
  { name: 'startTs', type: 'uint64', internalType: 'uint64' },
  { name: 'lockTs', type: 'uint64', internalType: 'uint64' },
  { name: 'closeTs', type: 'uint64', internalType: 'uint64' },
  { name: 'feeBps', type: 'uint16', internalType: 'uint16' },
  { name: 'bufferSeconds', type: 'uint16', internalType: 'uint16' },
  { name: 'locked', type: 'bool', internalType: 'bool' },
  { name: 'settled', type: 'bool', internalType: 'bool' },
  { name: 'voided', type: 'bool', internalType: 'bool' },
  { name: 'lockPrice', type: 'int256', internalType: 'int256' },
  { name: 'closePrice', type: 'int256', internalType: 'int256' },
  { name: 'lockOracleId', type: 'uint80', internalType: 'uint80' },
  { name: 'closeOracleId', type: 'uint80', internalType: 'uint80' },
  { name: 'oracleMaxAge', type: 'uint32', internalType: 'uint32' },
  { name: 'upAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'downAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'rewardBaseAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'rewardPoolAmount', type: 'uint256', internalType: 'uint256' },
] as const;

export const marketAbi = [
  // ── round engine ──────────────────────────────────────────────────────────
  /**
   * Permissionless. `boundaryRoundId` must be the oracle round id of the last print at or before
   * `boundaryTimestamp()`; the contract proves it, so settlement carries no timing discretion.
   * A wrong or unprovable id REVERTS with `InvalidBoundaryProof`; only a timeout past the round's
   * own `bufferSeconds` voids it into refunds.
   */
  {
    type: 'function',
    name: 'executeRound',
    inputs: [{ name: 'boundaryRoundId', type: 'uint80', internalType: 'uint80' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  /** The boundary timestamp the next `executeRound` call must price (`lockTs` of `currentEpoch`). */
  {
    type: 'function',
    name: 'boundaryTimestamp',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  /** Off-chain helper (eth_call only): walk back to the round id to pass to `executeRound`. */
  {
    type: 'function',
    name: 'findRoundIdAt',
    inputs: [
      { name: 'targetTs', type: 'uint256', internalType: 'uint256' },
      { name: 'startFrom', type: 'uint80', internalType: 'uint80' },
      { name: 'maxSteps', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [
      { name: 'roundId', type: 'uint80', internalType: 'uint80' },
      { name: 'found', type: 'bool', internalType: 'bool' },
    ],
    stateMutability: 'view',
  },
  /**
   * Batch form of `getRound`. The daily report walks a whole local day of the epoch grid, and one
   * call per minute-slot would be thousands of round trips against a public data-seed node.
   */
  {
    type: 'function',
    name: 'getRounds',
    inputs: [{ name: 'epochs', type: 'uint256[]', internalType: 'uint256[]' }],
    outputs: [
      { name: '', type: 'tuple[]', internalType: 'struct UpDownMarketBase.Round[]', components: roundStructComponents },
    ],
    stateMutability: 'view',
  },
  /** Public `ledger` mapping getter: one account's stake in one epoch, and whether it has collected. */
  {
    type: 'function',
    name: 'ledger',
    inputs: [
      { name: 'epoch', type: 'uint256', internalType: 'uint256' },
      { name: 'user', type: 'address', internalType: 'address' },
    ],
    outputs: [
      { name: 'upAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'downAmount', type: 'uint256', internalType: 'uint256' },
      { name: 'claimed', type: 'bool', internalType: 'bool' },
    ],
    stateMutability: 'view',
  },
  /**
   * The append-only, strictly increasing list of epochs an account has bet in, plus its length.
   * Strictly increasing because a bet is only accepted on `currentEpoch`, which never moves
   * backwards — which is what lets a caller binary-search it for a time window instead of reading
   * an account's entire history every day.
   */
  {
    type: 'function',
    name: 'userEpochs',
    inputs: [
      { name: 'user', type: 'address', internalType: 'address' },
      { name: 'offset', type: 'uint256', internalType: 'uint256' },
      { name: 'limit', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [
      { name: 'epochs', type: 'uint256[]', internalType: 'uint256[]' },
      { name: 'total', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'view',
  },
  /** Protocol revenue accrued and not yet withdrawn. */
  {
    type: 'function',
    name: 'treasuryAmount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  /** Settlement asset still owed to users: stakes not yet claimed or refunded. */
  {
    type: 'function',
    name: 'outstanding',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRound',
    inputs: [{ name: 'epoch', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      { name: '', type: 'tuple', internalType: 'struct UpDownMarketBase.Round', components: roundStructComponents },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'currentEpoch',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  /** True only while user funds still need a lock or settlement transaction. */
  {
    type: 'function',
    name: 'maintenanceRequired',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'interval',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'bufferSeconds',
    inputs: [],
    outputs: [{ name: '', type: 'uint16', internalType: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'oracleMaxAge',
    inputs: [],
    outputs: [{ name: '', type: 'uint32', internalType: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'genesisStarted',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'paused',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'oracle',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IAggregatorV3' }],
    stateMutability: 'view',
  },
  /**
   * The aggregator phase this market is bound to **for life** (`roundId >> 64`).
   *
   * `_tryRound` throws away any print from another phase, so a boundary id outside this phase is not
   * a proof the market can accept: `executeRound` reverts `InvalidBoundaryProof` rather than voiding.
   * The keeper reads it so it can refuse to send such an id at all.
   */
  {
    type: 'function',
    name: 'oraclePhase',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'settlementAsset',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'epochAnchor',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'anchorTs',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },

  // ── events decoded from the keeper's own receipts ─────────────────────────
  {
    type: 'event',
    name: 'RoundLocked',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'lockPrice', type: 'int256', indexed: false, internalType: 'int256' },
      { name: 'oracleRoundId', type: 'uint80', indexed: false, internalType: 'uint80' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoundSettled',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'closePrice', type: 'int256', indexed: false, internalType: 'int256' },
      { name: 'oracleRoundId', type: 'uint80', indexed: false, internalType: 'uint80' },
      { name: 'rewardBase', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'rewardPool', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'fee', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoundVoided',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'reason', type: 'uint8', indexed: false, internalType: 'uint8' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoundStarted',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'startTs', type: 'uint64', indexed: false, internalType: 'uint64' },
      { name: 'lockTs', type: 'uint64', indexed: false, internalType: 'uint64' },
      { name: 'closeTs', type: 'uint64', indexed: false, internalType: 'uint64' },
      { name: 'feeBps', type: 'uint16', indexed: false, internalType: 'uint16' },
    ],
    anonymous: false,
  },

  // ── custom errors, so viem decodes a revert into a readable name ──────────
  { type: 'error', name: 'NotStarted', inputs: [] },
  { type: 'error', name: 'InvalidBoundaryProof', inputs: [] },
  { type: 'error', name: 'TooEarly', inputs: [] },
  { type: 'error', name: 'EnforcedPause', inputs: [] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'TimestampOverflow', inputs: [] },
] as const;

export const aggregatorAbi = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'description',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRoundData',
    inputs: [{ name: 'roundId', type: 'uint80', internalType: 'uint80' }],
    outputs: [
      { name: 'roundId_', type: 'uint80', internalType: 'uint80' },
      { name: 'answer', type: 'int256', internalType: 'int256' },
      { name: 'startedAt', type: 'uint256', internalType: 'uint256' },
      { name: 'updatedAt', type: 'uint256', internalType: 'uint256' },
      { name: 'answeredInRound', type: 'uint80', internalType: 'uint80' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80', internalType: 'uint80' },
      { name: 'answer', type: 'int256', internalType: 'int256' },
      { name: 'startedAt', type: 'uint256', internalType: 'uint256' },
      { name: 'updatedAt', type: 'uint256', internalType: 'uint256' },
      { name: 'answeredInRound', type: 'uint80', internalType: 'uint80' },
    ],
    stateMutability: 'view',
  },
] as const;

/** BSC-testnet-only keeper-fed feed. */
export const relayAggregatorAbi = [
  ...aggregatorAbi,
  {
    type: 'function',
    name: 'relay',
    inputs: [{ name: 'answer', type: 'int256', internalType: 'int256' }],
    outputs: [{ name: 'roundId', type: 'uint80', internalType: 'uint80' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'latestId',
    inputs: [],
    outputs: [{ name: '', type: 'uint80', internalType: 'uint80' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'updater',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'AnswerRelayed',
    inputs: [
      { name: 'roundId', type: 'uint80', indexed: true, internalType: 'uint80' },
      { name: 'answer', type: 'int256', indexed: false, internalType: 'int256' },
      { name: 'updatedAt', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'NotUpdater', inputs: [] },
  { type: 'error', name: 'BadAnswer', inputs: [] },
  { type: 'error', name: 'NoData', inputs: [] },
] as const;

/** Void reason codes emitted in `RoundVoided(epoch, reason)`. */
export const VOID_REASONS: Readonly<Record<number, string>> = Object.freeze({
  1: 'oracle-no-usable-print-at-boundary',
  2: 'tie',
  3: 'one-sided-book',
  4: 'never-locked',
  5: 'settlement-window-elapsed',
});

export function voidReasonName(code: number): string {
  return VOID_REASONS[code] ?? `unknown-${code}`;
}

/**
 * Void reasons the KEEPER is answerable for, as opposed to the ones that are the market working as
 * designed.
 *
 * `tie` and `one-sided-book` are outcomes, not failures: nobody took the other side, or the price
 * came back to exactly where it started. Every stake is refunded in full with zero fee and no
 * operational change would prevent either. The other three all mean the same thing — the boundary
 * price the round needed never made it on chain in time — and that is the keeper's job.
 */
export const KEEPER_FAULT_VOID_REASONS: readonly string[] = Object.freeze([
  VOID_REASONS[1] as string, // oracle-no-usable-print-at-boundary
  VOID_REASONS[4] as string, // never-locked
  VOID_REASONS[5] as string, // settlement-window-elapsed
]);

/**
 * Is this void the keeper's fault? An unrecognised reason counts as one: a code this build does not
 * know about means the keeper no longer understands the contract it is driving, which is not a
 * thing to stay quiet about.
 */
export function isKeeperFaultVoid(reason: string): boolean {
  return KEEPER_FAULT_VOID_REASONS.includes(reason) || reason.startsWith('unknown-');
}
