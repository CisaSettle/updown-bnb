/**
 * Minimal, hand-pinned ABI fragments for the contracts the keeper touches.
 *
 * Inlined (rather than imported from `packages/abi/*.json`) so the keeper builds and ships as a
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
   * A wrong or missing id does not revert — it voids the round into refunds.
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

export const registryAbi = [
  {
    type: 'function',
    name: 'allMarkets',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct UpDownRegistry.MarketInfo[]',
        components: [
          { name: 'market', type: 'address', internalType: 'address' },
          { name: 'asset', type: 'address', internalType: 'address' },
          { name: 'oracle', type: 'address', internalType: 'address' },
          { name: 'interval', type: 'uint64', internalType: 'uint64' },
          { name: 'enabled', type: 'bool', internalType: 'bool' },
          { name: 'label', type: 'string', internalType: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
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
