/* External Imports */
import { Contract, Signer, utils } from 'ethers'
import {
  TransactionResponse,
  TransactionReceipt,
} from '@ethersproject/abstract-provider'
import { Promise as bPromise } from 'bluebird'
import { Logger } from '@eth-optimism/core-utils'
import { OptimismProvider } from '@eth-optimism/provider'
import { getContractFactory } from '@eth-optimism/contracts'

/* Internal Imports */
import { Address, Bytes32 } from '../coders'

export interface RollupInfo {
  signer: Address
  mode: 'sequencer' | 'verifier'
  syncing: boolean
  l1BlockHash: Bytes32
  l1BlockHeight: number
  addresses: {
    canonicalTransactionChain: Address
    stateCommitmentChain: Address
    addressResolver: Address
    l1ToL2TransactionQueue: Address
    sequencerDecompression: Address
  }
}
export interface Range {
  start: number
  end: number
}

export abstract class BatchSubmitter {
  protected rollupInfo: RollupInfo
  protected chainContract: Contract
  protected l2ChainId: number
  protected syncing: boolean
  protected lastBatchSubmissionTimestamp: number = 0

  constructor(
    readonly signer: Signer,
    readonly l2Provider: OptimismProvider,
    readonly minTxSize: number,
    readonly maxTxSize: number,
    readonly maxBatchSize: number,
    readonly maxBatchSubmissionTime: number,
    readonly numConfirmations: number,
    readonly resubmissionTimeout: number,
    readonly finalityConfirmations: number,
    readonly pullFromAddressManager: boolean,
    readonly minBalanceEther: number,
    readonly log: Logger
  ) {}

  public abstract async _submitBatch(
    startBlock: number,
    endBlock: number
  ): Promise<TransactionReceipt>
  public abstract async _onSync(): Promise<TransactionReceipt>
  public abstract async _getBatchStartAndEnd(): Promise<Range>
  public abstract async _updateChainInfo(): Promise<void>

  public async submitNextBatch(): Promise<TransactionReceipt> {
    if (typeof this.l2ChainId === 'undefined') {
      this.l2ChainId = await this._getL2ChainId()
    }
    await this._updateChainInfo()
    await this._checkBalance()

    if (this.syncing === true) {
      this.log.info(
        'Syncing mode enabled! Skipping batch submission and clearing queue...'
      )
      return this._onSync()
    }
    const range = await this._getBatchStartAndEnd()
    if (!range) {
      return
    }

    return this._submitBatch(range.start, range.end)
  }

  protected async _checkBalance(): Promise<void> {
    const address = await this.signer.getAddress()
    const balance = await this.signer.getBalance()
    const ether = utils.formatEther(balance)
    const num = parseFloat(ether)

    this.log.info(`Balance ${address}: ${ether} ether`)
    if (num < this.minBalanceEther) {
      this.log.error(`Current balance of ${num} lower than min safe balance of ${this.minBalanceEther}`)
    }
  }

  protected async _getRollupInfo(): Promise<RollupInfo> {
    return this.l2Provider.send('rollup_getInfo', [])
  }

  protected async _getL2ChainId(): Promise<number> {
    return this.l2Provider.send('eth_chainId', [])
  }

  protected async _getChainAddresses(
    info: RollupInfo
  ): Promise<{ ctcAddress: string; sccAddress: string }> {
    if (!this.pullFromAddressManager) {
      return {
        ctcAddress: info.addresses.canonicalTransactionChain,
        sccAddress: info.addresses.stateCommitmentChain,
      }
    }
    const addressManager = (
      await getContractFactory('Lib_AddressManager', this.signer)
    ).attach(info.addresses.addressResolver)
    const sccAddress = await addressManager.getAddress(
      'OVM_StateCommitmentChain'
    )
    const ctcAddress = await addressManager.getAddress(
      'OVM_CanonicalTransactionChain'
    )
    return {
      ctcAddress,
      sccAddress,
    }
  }

  protected _shouldSubmitBatch(
    batchSizeInBytes: number
  ): boolean {
    const isTimeoutReached = this.lastBatchSubmissionTimestamp + this.maxBatchSubmissionTime <= Date.now()
    if (batchSizeInBytes < this.minTxSize) {
      if (!isTimeoutReached) {
        this.log.info(`Batch is too small & max submission timeout not reached. Skipping batch submission...`)
        return false
      }
      this.log.info(`Timeout reached.`)
    }
    return true
  }

  public static async getReceiptWithResubmission(
    response: TransactionResponse,
    receiptPromises: Array<Promise<TransactionReceipt>>,
    signer: Signer,
    numConfirmations: number,
    resubmissionTimeout: number,
    log: Logger,
  ): Promise<TransactionReceipt> {
    const receiptPromise = response.wait(numConfirmations)
    receiptPromises.push(receiptPromise)
    // Wait for the tx & if it takes too long resubmit
    const sleepAndReturnResubmit = async (timeout: number) => {
      await new Promise((r) => setTimeout(r, timeout))
      return 'resubmit'
    }
    const promises = [...receiptPromises, sleepAndReturnResubmit(
      resubmissionTimeout
    )]
    const val = await bPromise.any(Promise.resolve(promises))

    if (val === 'resubmit') {
      log.debug(`Tx resubmission timeout reached for hash: ${response.hash}; nonce: ${response.nonce}.
                Resubmitting tx...`)
      const tx = {
        to: response.to,
        data: response.data,
        nonce: response.nonce,
        value: response.value,
        gasLimit: response.gasLimit,
      }
      const newRes = await signer.sendTransaction(tx)
      log.debug('Resubmission tx response:', newRes)
      return BatchSubmitter.getReceiptWithResubmission(
        newRes,
        receiptPromises,
        signer,
        numConfirmations,
        resubmissionTimeout,
        log
      )
    } else {
      return val as TransactionReceipt
    }
  }

  protected async _submitAndLogTx(
    txPromise: Promise<TransactionResponse>,
    successMessage: string
  ): Promise<TransactionReceipt> {
    const response = await txPromise
    this.lastBatchSubmissionTimestamp = Date.now()
    this.log.debug('Transaction response:', response)
    this.log.debug('Waiting for receipt...')
    const receipt = await BatchSubmitter.getReceiptWithResubmission(
      response,
      [],
      this.signer,
      this.numConfirmations,
      this.resubmissionTimeout,
      this.log
    )
    this.log.debug('Transaction receipt:', receipt)
    this.log.info(successMessage)
    return receipt
  }
}
