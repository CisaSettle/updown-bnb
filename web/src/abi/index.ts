import { erc20Abi, type Abi } from 'viem'
import { upDownMarketERC20Abi } from './UpDownMarketERC20'
import { upDownMarketNativeAbi } from './UpDownMarketNative'
import { upDownRegistryAbi } from './UpDownRegistry'
import { testUSDTAbi } from './TestUSDT'
import { relayAggregatorAbi } from './RelayAggregator'

export { upDownMarketERC20Abi, upDownMarketNativeAbi, upDownRegistryAbi, testUSDTAbi, relayAggregatorAbi, erc20Abi }

/**
 * Every read-only view on a market is byte-identical across the ERC20 and native implementations
 * (they share `UpDownMarketBase`), so one ABI drives every read. Only `betUp` / `betDown` differ,
 * and those pick the concrete ABI at call time.
 */
export const marketViewAbi = upDownMarketERC20Abi

/** Minimal Chainlink AggregatorV3 surface — the live price shown next to the strike. */
export const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'description',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
  // Needed to resolve the print a boundary actually settles on — `latestRoundData` is the wrong
  // number once the boundary has passed.
  {
    type: 'function',
    name: 'getRoundData',
    inputs: [{ name: 'roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
] as const

type AbiErrorItem = { readonly type: string; readonly name?: string }

/**
 * Union of every custom error the app can possibly receive, so a revert is always decodable to a
 * name we can map to human copy — a user must never see a raw `0x…` selector.
 */
export const allErrorsAbi: Abi = (() => {
  const seen = new Set<string>()
  const out: AbiErrorItem[] = []
  for (const abi of [
    upDownMarketERC20Abi,
    upDownMarketNativeAbi,
    upDownRegistryAbi,
    testUSDTAbi,
    relayAggregatorAbi,
    erc20Abi,
  ] as readonly (readonly AbiErrorItem[])[]) {
    for (const item of abi) {
      if (item.type !== 'error' || !item.name) continue
      const key = JSON.stringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out as unknown as Abi
})()
