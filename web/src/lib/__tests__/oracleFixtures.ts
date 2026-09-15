import { ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem'
import { aggregatorV3Abi } from '../../abi'

/** The actual error envelope returned by viem for an individual oracle revert. */
export const reverted = (functionName = 'getRoundData') => ({
  status: 'failure',
  error: new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: aggregatorV3Abi, functionName, message: 'No data present' }),
    { abi: aggregatorV3Abi, functionName, args: [1n] },
  ),
})
