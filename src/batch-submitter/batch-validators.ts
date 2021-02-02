/* External Imports */
import { getLogger } from '@eth-optimism/core-utils'

import {
  CanonicalTransactionChainContract,
  encodeAppendSequencerBatch,
  BatchContext,
  AppendSequencerBatchParams,
} from '../transaciton-chain-contract'

const log = getLogger('oe:batch-submitter:validation')

const validateMonotonicity = async (txBatchParams: AppendSequencerBatchParams): Promise<boolean> => {
  return true
}

export const validators = {
  validateMonotonicity
}
