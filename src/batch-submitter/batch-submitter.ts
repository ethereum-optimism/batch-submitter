/* External Imports */
import { Contract, Signer, utils } from 'ethers'
import { TransactionReceipt } from '@ethersproject/abstract-provider'
import * as ynatm from '@eth-optimism/ynatm'
import { Logger } from '@eth-optimism/core-utils'
import { OptimismProvider } from '@eth-optimism/provider'
import { getContractFactory } from '@eth-optimism/contracts'
import { JsonRpcProvider } from '@ethersproject/providers'
import { formatEther } from 'ethers/lib/utils'
import { itxWaitForTx, sendTxWithITX } from '../utils'

export interface RollupInfo {
  mode: 'sequencer' | 'verifier'
  syncing: boolean
  ethContext: {
    blockNumber: number
    timestamp: number
  }
  rollupContext: {
    index: number
    queueIndex: number
  }
}
export interface Range {
  start: number
  end: number
}
export interface ResubmissionConfig {
  resubmissionTimeout: number
  minGasPriceInGwei: number
  maxGasPriceInGwei: number
  gasRetryIncrement: number
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
    readonly addressManagerAddress: string,
    readonly minBalanceEther: number,
    readonly minGasPriceInGwei: number,
    readonly maxGasPriceInGwei: number,
    readonly gasRetryIncrement: number,
    readonly gasThresholdInGwei: number,
    readonly itxProvider: string,
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
      this.log.error(
        `Current balance of ${num} lower than min safe balance of ${this.minBalanceEther}`
      )
    }
  }

  protected async _getRollupInfo(): Promise<RollupInfo> {
    return this.l2Provider.send('rollup_getInfo', [])
  }

  protected async _getL2ChainId(): Promise<number> {
    return this.l2Provider.send('eth_chainId', [])
  }

  protected async _getChainAddresses(): Promise<{
    ctcAddress: string
    sccAddress: string
  }> {
    const addressManager = (
      await getContractFactory('Lib_AddressManager', this.signer)
    ).attach(this.addressManagerAddress)
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

  protected _shouldSubmitBatch(batchSizeInBytes: number): boolean {
    const isTimeoutReached =
      this.lastBatchSubmissionTimestamp + this.maxBatchSubmissionTime <=
      Date.now()
    if (batchSizeInBytes < this.minTxSize) {
      if (!isTimeoutReached) {
        this.log.info(
          `Batch is too small & max submission timeout not reached. Skipping batch submission...`
        )
        return false
      }
      this.log.info(`Timeout reached.`)
    }
    return true
  }

  public static async getReceiptWithResubmission(
    txFunc: (gasPrice) => Promise<TransactionReceipt>,
    resubmissionConfig: ResubmissionConfig,
    log: Logger
  ): Promise<TransactionReceipt> {
    const {
      resubmissionTimeout,
      minGasPriceInGwei,
      maxGasPriceInGwei,
      gasRetryIncrement,
    } = resubmissionConfig

    const receipt = await ynatm.send({
      sendTransactionFunction: txFunc,
      minGasPrice: ynatm.toGwei(minGasPriceInGwei),
      maxGasPrice: ynatm.toGwei(maxGasPriceInGwei),
      gasPriceScalingFunction: ynatm.LINEAR(gasRetryIncrement),
      delay: resubmissionTimeout,
    })

    log.debug('Resubmission tx receipt:', receipt)

    return receipt
  }

  private async _getMinGasPriceInGwei(): Promise<number> {
    if (this.minGasPriceInGwei !== 0) {
      return this.minGasPriceInGwei
    }
    let minGasPriceInGwei = parseInt(
      utils.formatUnits(await this.signer.getGasPrice(), 'gwei'),
      10
    )
    if (minGasPriceInGwei > this.maxGasPriceInGwei) {
      this.log.warn(
        'Minimum gas price is higher than max! Ethereum must be congested...'
      )
      minGasPriceInGwei = this.maxGasPriceInGwei
    }
    return minGasPriceInGwei
  }

  protected async _submitAndLogTx(
    to: string,
    data: string,
    successMessage: string
  ): Promise<TransactionReceipt> {
    this.lastBatchSubmissionTimestamp = Date.now()
    this.log.debug('Waiting for receipt...')

    // Enable ITX by setting a provider. It'll re-use the sequencer key.
    if (this.itxProvider !== '') {
      const itx = new JsonRpcProvider(
        'https://kovan.infura.io/v3/9e9102c2a0c34526accd6c64f5c52cdb'
      )
      const signer = this.signer.connect(itx)

      const gas = await itx.estimateGas(
        await signer.populateTransaction({ to, data })
      )

      const balance = await itx.send('relay_getBalance', [
        await signer.getAddress(),
      ])
      this.log.info(`Current ITX balance: ` + formatEther(balance))

      const relayTransactionHash = await sendTxWithITX(
        itx,
        signer,
        to,
        data,
        gas.toString()
      )

      this.log.info(`ITX relay transaction hash: ${relayTransactionHash}`)
      return itxWaitForTx(itx, relayTransactionHash)
    } else {
      // Use the esclator algorithm by Optimism.
      const sendTx = async (gasPrice): Promise<TransactionReceipt> => {
        const tx = await this.signer.sendTransaction({ to, data, gasPrice })
        return this.signer.provider.waitForTransaction(
          tx.hash,
          this.numConfirmations
        )
      }

      const resubmissionConfig: ResubmissionConfig = {
        resubmissionTimeout: this.resubmissionTimeout,
        minGasPriceInGwei: await this._getMinGasPriceInGwei(),
        maxGasPriceInGwei: this.maxGasPriceInGwei,
        gasRetryIncrement: this.gasRetryIncrement,
      }

      const receipt = await BatchSubmitter.getReceiptWithResubmission(
        sendTx,
        resubmissionConfig,
        this.log
      )

      this.log.debug('Transaction receipt:', receipt)
      this.log.info(successMessage)
      return receipt
    }
  }
}
