/* External Imports */
import { getLogger } from '@eth-optimism/core-utils'
import { exit } from 'process'
import { Wallet } from 'ethers'
import {
  Provider,
  JsonRpcProvider,
  TransactionReceipt,
} from '@ethersproject/providers'
import {
  getContractInterface,
  getContractFactory,
} from '@eth-optimism/contracts'
import { BlockWithTransactions, } from '@ethersproject/abstract-provider'
import {
  L2Block,
} from '..'
import {
  CanonicalTransactionChainContract,
} from '../transaciton-chain-contract'

import { OptimismProvider } from '@eth-optimism/provider'

/* Internal Imports */

const log = { debug: console.log }

export const run = async () => {
  const provider = new OptimismProvider('http://kovan.optimism.io:8545')
  log.debug(provider)

  const lastBlockNumber = (await provider.getBlock('latest')).number
  const test = await provider.getBlockWithTransactions(lastBlockNumber)
  const blocks: L2Block[]  = []
  const l1ToL2Blocks: L2Block[]  = []

  // for (let i = 1; i < lastBlockNumber; i++) {
  for (let i = 586; i < 596; i++) {
    log.debug('we are here')
    blocks.push(await provider.getBlockWithTransactions(i) as L2Block)
  }

  const queueTxs: L2Block[]  = []
  for (const block of blocks) {
    log.debug(block.transactions[0].queueOrigin)
    if (block.transactions[0].queueOrigin === ('sequencer' as any)) {
      log.debug('sequencer tx found!')
    } else {
      queueTxs.push(block)
    }
  }

  log.debug('~~~~~~~~~~~~ ALL BLOCKS AND TRANSACTIONS ~~~~~~~~~~~~~~')
  log.debug(JSON.stringify(blocks, null, 2))
  log.debug('~~~~~~~~~~~~ QUEUE BLOCKS AND TRANSACTIONS ~~~~~~~~~~~~~~')
  log.debug(JSON.stringify(queueTxs, null, 2))

  // Get all of the queue elements
  const ctcAddress = '0x1c0B0A94E284B9D36a0726Decb7056991b92d509'
  const kovanProvider = new JsonRpcProvider('https://eth-kovan.alchemyapi.io/v2/kgu-LwSCC4IuBjuMIZGl-IqIerkfM2tl')
  const wallet = new Wallet('0x1101010101010101010101010101010101010101010101010101010101010100', kovanProvider)
  const ctc = (await getContractFactory('OVM_CanonicalTransactionChain', wallet)).attach(ctcAddress)

  const totalQueueElements = await ctc.getNextQueueIndex()
  log.debug(totalQueueElements)

  // const totalQueueElements = (await ctc.getNextQueueIndex()) + (await ctc.getNumPendingQueueElements())
  // log.debug(totalQueueElements)
}
