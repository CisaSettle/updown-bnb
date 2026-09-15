import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem'

/** Transport failures never prove that an oracle print is absent. */
export function oracleReadStatus(item: unknown): 'success' | 'reverted' | 'unread' {
  const entry = item as { status?: string; error?: unknown } | undefined
  if (entry?.status === 'success') return 'success'
  if (entry?.status !== 'failure' || !(entry.error instanceof BaseError)) return 'unread'
  const execution = entry.error.walk((cause) => cause instanceof ContractFunctionExecutionError)
  const reverted = entry.error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  // An aggregate3 revert concerns the batch, not the existence of any individual feed round.
  return execution instanceof ContractFunctionExecutionError && execution.functionName === 'getRoundData' &&
    reverted instanceof ContractFunctionRevertedError ? 'reverted' : 'unread'
}
