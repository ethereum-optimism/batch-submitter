/* External Imports */
import { Promise as bPromise } from 'bluebird'
import { BigNumber, Signer, ethers, Wallet, Contract } from 'ethers'
import {
  TransactionResponse,
  TransactionReceipt,
} from '@ethersproject/abstract-provider'
import {
  getContractInterface,
  getContractFactory,
} from '@eth-optimism/contracts'
import { getContractInterface as getNewContractInterface } from 'new-contracts'
import { OptimismProvider } from '@eth-optimism/provider'
import {
  Logger,
  EIP155TxData,
  TxType,
  ctcCoder,
  EthSignTxData,
  txTypePlainText,
} from '@eth-optimism/core-utils'

/* Internal Imports */
import {
  CanonicalTransactionChainContract,
  encodeAppendSequencerBatch,
  BatchContext,
  AppendSequencerBatchParams,
} from '../transaction-chain-contract'

import {
  L2Block,
  BatchElement,
  Batch,
  QueueOrigin,
  queueOriginPlainText,
} from '..'
import { RollupInfo, Range, BatchSubmitter, BLOCK_OFFSET } from '.'

export interface AutoFixBatchOptions {
  fixDoublePlayedDeposits: boolean
  fixMonotonicity: boolean
}

export class TransactionBatchSubmitter extends BatchSubmitter {
  protected chainContract: CanonicalTransactionChainContract
  protected l2ChainId: number
  protected syncing: boolean
  protected lastL1BlockNumber: number
  private disableQueueBatchAppend: boolean
  private autoFixBatchOptions: AutoFixBatchOptions

  constructor(
    signer: Signer,
    l2Provider: OptimismProvider,
    minTxSize: number,
    maxTxSize: number,
    maxBatchSize: number,
    maxBatchSubmissionTime: number,
    numConfirmations: number,
    resubmissionTimeout: number,
    addressManagerAddress: string,
    minBalanceEther: number,
    minGasPriceInGwei: number,
    maxGasPriceInGwei: number,
    gasRetryIncrement: number,
    gasThresholdInGwei: number,
    log: Logger,
    disableQueueBatchAppend: boolean,
    autoFixBatchOptions: AutoFixBatchOptions = {
      fixDoublePlayedDeposits: false,
      fixMonotonicity: false,
    } // TODO: Remove this
  ) {
    super(
      signer,
      l2Provider,
      minTxSize,
      maxTxSize,
      maxBatchSize,
      maxBatchSubmissionTime,
      numConfirmations,
      resubmissionTimeout,
      0, // Supply dummy value because it is not used.
      addressManagerAddress,
      minBalanceEther,
      minGasPriceInGwei,
      maxGasPriceInGwei,
      gasRetryIncrement,
      gasThresholdInGwei,
      log
    )
    this.disableQueueBatchAppend = disableQueueBatchAppend
    this.autoFixBatchOptions = autoFixBatchOptions
  }

  /*****************************
   * Batch Submitter Overrides *
   ****************************/

  public async _updateChainInfo(): Promise<void> {
    const info: RollupInfo = await this._getRollupInfo()
    if (info.mode === 'verifier') {
      this.log.error(
        'Verifier mode enabled! Batch submitter only compatible with sequencer mode'
      )
      process.exit(1)
    }
    this.syncing = info.syncing
    const addrs = await this._getChainAddresses()
    const ctcAddress = addrs.ctcAddress

    if (
      typeof this.chainContract !== 'undefined' &&
      ctcAddress === this.chainContract.address
    ) {
      return
    }

    const unwrapped_OVM_CanonicalTransactionChain = (
      await getContractFactory('OVM_CanonicalTransactionChain', this.signer)
    ).attach(ctcAddress)

    this.chainContract = new CanonicalTransactionChainContract(
      unwrapped_OVM_CanonicalTransactionChain.address,
      getContractInterface('OVM_CanonicalTransactionChain'),
      this.signer
    )
    this.log.info('Initialized new CTC', {
      address: this.chainContract.address,
    })
    return
  }

  public async _onSync(): Promise<TransactionReceipt> {
    const pendingQueueElements = await this.chainContract.getNumPendingQueueElements()

    if (pendingQueueElements !== 0) {
      this.log.info(
        'Syncing mode enabled! Skipping batch submission and clearing queue elements',
        { pendingQueueElements }
      )

      if (!this.disableQueueBatchAppend) {
        const nonce = await this.signer.getTransactionCount()
        const contractFunction = async (
          gasPrice
        ): Promise<TransactionReceipt> => {
          const tx = await this.chainContract.appendQueueBatch(99999999, {
            nonce,
            gasPrice,
          })
          return this.signer.provider.waitForTransaction(
            tx.hash,
            this.numConfirmations
          )
        }

        // Empty the queue with a huge `appendQueueBatch(..)` call
        return this._submitAndLogTx(contractFunction, 'Cleared queue!')
      }
    }
    this.log.info('Syncing mode enabled but queue is empty. Skipping...')
    return
  }

  // TODO: Remove this function and use geth for lastL1BlockNumber!
  private async _updateLastL1BlockNumber() {
    const pendingQueueElements = await this.chainContract.getNumPendingQueueElements()

    if (pendingQueueElements !== 0) {
      const nextQueueIndex = await this.chainContract.getNextQueueIndex()
      const queueElement = await this.chainContract.getQueueElement(
        nextQueueIndex
      )
      this.lastL1BlockNumber = queueElement[2] // The block number is the 3rd element returned in the array....
    } else {
      const curBlockNum = await this.chainContract.provider.getBlockNumber()
      if (!this.lastL1BlockNumber) {
        // Set the block number to the current l1BlockNumber
        this.lastL1BlockNumber = curBlockNum
      } else {
        if (curBlockNum - this.lastL1BlockNumber > 30) {
          // If the lastL1BlockNumber is too old, then set it to a recent
          // block number. (10 blocks ago to prevent reorgs)
          this.lastL1BlockNumber = curBlockNum - 10
        }
      }
    }
  }

  public async _getBatchStartAndEnd(): Promise<Range> {
    // TODO: Remove BLOCK_OFFSET by adding a tx to Geth's genesis
    const startBlock =
      (await this.chainContract.getTotalElements()).toNumber() + BLOCK_OFFSET
    const endBlock =
      Math.min(
        startBlock + this.maxBatchSize,
        await this.l2Provider.getBlockNumber()
      ) + 1 // +1 because the `endBlock` is *exclusive*
    if (startBlock >= endBlock) {
      if (startBlock > endBlock) {
        this.log
          .error(`More chain elements in L1 (${startBlock}) than in the L2 node (${endBlock}).
                   This shouldn't happen because we don't submit batches if the sequencer is syncing.`)
      }
      this.log.info('No txs to submit. Skipping batch submission...')
      return
    }
    return {
      start: startBlock,
      end: endBlock,
    }
  }

  public async _submitBatch(
    startBlock: number,
    endBlock: number
  ): Promise<TransactionReceipt> {
    // Do not submit batch if gas price above threshold
    const gasPriceInGwei = parseInt(
      ethers.utils.formatUnits(await this.signer.getGasPrice(), 'gwei'),
      10
    )
    if (gasPriceInGwei > this.gasThresholdInGwei) {
      this.log.warn(
        'Gas price is higher than gras price threshold; aborting batch submission',
        {
          gasPriceInGwei,
          gasThresholdInGwei: this.gasThresholdInGwei,
        }
      )
      return
    }

    const [
      batchParams,
      wasBatchTruncated,
    ] = await this._generateSequencerBatchParams(startBlock, endBlock)
    const batchSizeInBytes = encodeAppendSequencerBatch(batchParams).length * 2

    // Only submit batch if one of the following is true:
    // 1. it was truncated
    // 2. it is large enough
    // 3. enough time has passed since last submission
    if (!wasBatchTruncated && !this._shouldSubmitBatch(batchSizeInBytes)) {
      return
    }
    this.log.debug('Submitting batch.', {
      calldata: batchParams,
    })

    const nonce = await this.signer.getTransactionCount()
    const contractFunction = async (gasPrice): Promise<TransactionReceipt> => {
      const tx = await this.chainContract.appendSequencerBatch(batchParams, {
        nonce,
        gasPrice,
      })
      return this.signer.provider.waitForTransaction(
        tx.hash,
        this.numConfirmations
      )
    }
    return this._submitAndLogTx(contractFunction, 'Submitted batch!')
  }

  /*********************
   * Private Functions *
   ********************/

  private async _generateSequencerBatchParams(
    startBlock: number,
    endBlock: number
  ): Promise<[AppendSequencerBatchParams, boolean]> {
    // Get all L2 BatchElements for the given range
    // For now we need to update our internal `lastL1BlockNumber` value
    // which is used when submitting batches.
    this._updateLastL1BlockNumber() // TODO: Remove this
    const blockRange = endBlock - startBlock
    let batch: Batch = await bPromise.map(
      [...Array(blockRange).keys()],
      (i) => {
        this.log.debug('Fetching L2BatchElement', { blockNo: startBlock + i })
        return this._getL2BatchElement(startBlock + i)
      },
      { concurrency: 50 }
    )

    // Fix our batches if we are configured to. TODO: Remove this.
    batch = await this._fixBatch(batch)
    if (!(await this._validateBatch(batch))) {
      this.log.error('Batch is malformed! Cannot submit next batch!')
      throw new Error('Batch is malformed! Cannot submit next batch!')
    }
    let sequencerBatchParams = await this._getSequencerBatchParams(
      startBlock,
      batch
    )
    let wasBatchTruncated = false
    let encoded = encodeAppendSequencerBatch(sequencerBatchParams)
    while (encoded.length / 2 > this.maxTxSize) {
      batch.splice(Math.ceil((batch.length * 2) / 3)) // Delete 1/3rd of all of the batch elements
      sequencerBatchParams = await this._getSequencerBatchParams(
        startBlock,
        batch
      )
      encoded = encodeAppendSequencerBatch(sequencerBatchParams)
      //  This is to prevent against the case where a batch is oversized,
      //  but then gets truncated to the point where it is under the minimum size.
      //  In this case, we want to submit regardless of the batch's size.
      wasBatchTruncated = true
    }
    return [sequencerBatchParams, wasBatchTruncated]
  }

  /**
   * Returns true if the batch is valid.
   */
  protected async _validateBatch(batch: Batch): Promise<boolean> {
    // Verify all of the queue elements are what we expect
    let nextQueueIndex = await this.chainContract.getNextQueueIndex()
    for (const ele of batch) {
      this.log.debug('Verifying batch element', { ele })
      if (!ele.isSequencerTx) {
        this.log.debug('Checking queue equality against L1 queue index', {
          nextQueueIndex,
        })
        if (!(await this._doesQueueElementMatchL1(nextQueueIndex, ele))) {
          return false
        }
        nextQueueIndex++
      }
    }

    // Verify all of the batch elements are monotonic
    let lastTimestamp: number
    let lastBlockNumber: number
    for (const ele of batch) {
      if (ele.timestamp < lastTimestamp) {
        this.log.error('Timestamp monotonicity violated! Element', { ele })
        return false
      }
      if (ele.blockNumber < lastBlockNumber) {
        this.log.error('Block Number monotonicity violated! Element', { ele })
        return false
      }
      lastTimestamp = ele.timestamp
      lastBlockNumber = ele.blockNumber
    }
    return true
  }

  private async _doesQueueElementMatchL1(
    queueIndex: number,
    queueElement: BatchElement
  ): Promise<boolean> {
    const logEqualityError = (name, index, expected, got) => {
      this.log.error('Observed mismatched values', {
        index,
        expected,
        got,
      })
    }

    let isEqual = true
    const [
      queueEleHash,
      timestamp,
      blockNumber,
    ] = await this.chainContract.getQueueElement(queueIndex)

    // TODO: Verify queue element hash equality. The queue element hash can be computed with:
    // keccak256( abi.encode( msg.sender, _target, _gasLimit, _data))

    // Check timestamp & blockNumber equality
    if (timestamp !== queueElement.timestamp) {
      isEqual = false
      logEqualityError(
        'Timestamp',
        queueIndex,
        timestamp,
        queueElement.timestamp
      )
    }
    if (blockNumber !== queueElement.blockNumber) {
      isEqual = false
      logEqualityError(
        'Block Number',
        queueIndex,
        blockNumber,
        queueElement.blockNumber
      )
    }
    return isEqual
  }

  /**
   * Takes in a batch which is potentially malformed & returns corrected version.
   * Current fixes that are supported:
   * - Double played deposits.
   */
  private async _fixBatch(batch: Batch): Promise<Batch> {
    const fixDoublePlayedDeposits = async (b: Batch): Promise<Batch> => {
      let nextQueueIndex = await this.chainContract.getNextQueueIndex()
      const fixedBatch: Batch = []
      for (const ele of b) {
        if (!ele.isSequencerTx) {
          if (!(await this._doesQueueElementMatchL1(nextQueueIndex, ele))) {
            this.log.warn('Fixing double played queue element.', {
              nextQueueIndex,
            })
            fixedBatch.push(await this._fixQueueElement(nextQueueIndex, ele))
            continue
          }
          nextQueueIndex++
        }
        fixedBatch.push(ele)
      }
      return fixedBatch
    }

    // TODO: Remove this super complex logic and rely on Geth to actually supply correct block data.
    const fixMonotonicity = async (b: Batch): Promise<Batch> => {
      // The earliest allowed timestamp/blockNumber is the last timestamp submitted on chain.
      const {
        lastTimestamp,
        lastBlockNumber,
      } = await this._getLastTimestampAndBlockNumber()
      let earliestTimestamp = lastTimestamp
      let earliestBlockNumber = lastBlockNumber

      // The latest allowed timestamp/blockNumber is the next queue element!
      let nextQueueIndex = await this.chainContract.getNextQueueIndex()
      let latestTimestamp: number
      let latestBlockNumber: number

      // updateLatestTimestampAndBlockNumber is a helper which updates
      // the latest timestamp and block number based on the pending queue elements.
      const updateLatestTimestampAndBlockNumber = async () => {
        const pendingQueueElements = await this.chainContract.getNumPendingQueueElements()
        const nextRemoteQueueElements = await this.chainContract.getNextQueueIndex()
        const totalQueueElements =
          pendingQueueElements + nextRemoteQueueElements
        if (nextQueueIndex < totalQueueElements) {
          const [
            queueEleHash,
            queueTimestamp,
            queueBlockNumber,
          ] = await this.chainContract.getQueueElement(nextQueueIndex)
          latestTimestamp = queueTimestamp
          latestBlockNumber = queueBlockNumber
        } else {
          // If there are no queue elements left then just allow any timestamp/blocknumber
          latestTimestamp = Number.MAX_SAFE_INTEGER
          latestBlockNumber = Number.MAX_SAFE_INTEGER
        }
      }
      // Actually update the latest timestamp and block number
      await updateLatestTimestampAndBlockNumber()

      // Now go through our batch and fix the timestamps and block numbers
      // to automatically enforce monotonicity.
      const fixedBatch: Batch = []
      for (const ele of b) {
        if (!ele.isSequencerTx) {
          // Set the earliest allowed timestamp to the old latest and set the new latest
          // to the next queue element's timestamp / blockNumber
          earliestTimestamp = latestTimestamp
          earliestBlockNumber = latestBlockNumber
          nextQueueIndex++
          await updateLatestTimestampAndBlockNumber()
        }
        // Fix the element if its timestammp/blockNumber is too small
        if (
          ele.timestamp < earliestTimestamp ||
          ele.blockNumber < earliestBlockNumber
        ) {
          this.log.warn('Fixing timestamp/blockNumber too small', {
            oldTimestamp: ele.timestamp,
            newTimestamp: earliestTimestamp,
            oldBlockNumber: ele.blockNumber,
            newBlockNumber: earliestBlockNumber,
          })
          fixedBatch.push({
            ...ele,
            timestamp: earliestTimestamp,
            blockNumber: earliestBlockNumber,
          })
          continue
        }
        // Fix the element if its timestammp/blockNumber is too large
        if (
          ele.timestamp > latestTimestamp ||
          ele.blockNumber > latestBlockNumber
        ) {
          this.log.warn('Fixing timestamp/blockNumber too large.', {
            oldTimestamp: ele.timestamp,
            newTimestamp: latestTimestamp,
            oldBlockNumber: ele.blockNumber,
            newBlockNumber: latestBlockNumber,
          })
          fixedBatch.push({
            ...ele,
            timestamp: latestTimestamp,
            blockNumber: latestBlockNumber,
          })
          continue
        }
        // No fixes needed!
        fixedBatch.push(ele)
      }
      return fixedBatch
    }

    if (this.autoFixBatchOptions.fixDoublePlayedDeposits) {
      batch = await fixDoublePlayedDeposits(batch)
    }
    if (this.autoFixBatchOptions.fixMonotonicity) {
      batch = await fixMonotonicity(batch)
    }
    return batch
  }

  private async _getLastTimestampAndBlockNumber(): Promise<{
    lastTimestamp: number
    lastBlockNumber: number
  }> {
    const manager = new Contract(
      this.addressManagerAddress,
      getNewContractInterface('Lib_AddressManager'),
      this.signer.provider
    )

    const addr = await manager.getAddress(
      'OVM_ChainStorageContainer:CTC:batches'
    )
    const container = new Contract(
      addr,
      getNewContractInterface('iOVM_ChainStorageContainer'),
      this.signer.provider
    )

    let meta = await container.getGlobalMetadata()
    // remove 0x
    meta = meta.slice(2)
    // convert to bytes27
    meta = meta.slice(10)

    const totalElements = meta.slice(-10)
    const nextQueueIndex = meta.slice(-20, -10)
    const lastTimestamp = parseInt(meta.slice(-30, -20), 16)
    const lastBlockNumber = parseInt(meta.slice(-40, -30), 16)
    this.log.debug('Retrieved timestamp and block number from CTC', {
      lastTimestamp,
      lastBlockNumber,
    })

    return { lastTimestamp, lastBlockNumber }
  }

  private async _fixQueueElement(
    queueIndex: number,
    queueElement: BatchElement
  ): Promise<BatchElement> {
    const [
      queueEleHash,
      timestamp,
      blockNumber,
    ] = await this.chainContract.getQueueElement(queueIndex)

    if (
      timestamp > queueElement.timestamp &&
      blockNumber > queueElement.blockNumber
    ) {
      this.log.warn(
        'Double deposit detected!!! Fixing by skipping the deposit & replacing with a dummy tx.'
      )
      // This implies that we've double played a deposit.
      // We can correct this by instead submitting a dummy sequencer tx
      const wallet = Wallet.createRandom()
      const gasLimit = 8_000_000
      const gasPrice = 0
      const chainId = 10
      const nonce = 0
      const rawTx = await wallet.signTransaction({
        gasLimit,
        gasPrice,
        chainId,
        nonce,
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
      })
      // tx: [0nonce, 1gasprice, 2startgas, 3to, 4value, 5data, 6v, 7r, 8s]
      const tx = ethers.utils.RLP.decode(rawTx)
      const dummyTx: EIP155TxData = {
        sig: {
          v: tx[6],
          r: tx[7],
          s: tx[8],
        },
        gasLimit,
        gasPrice,
        nonce,
        target: tx[3],
        data: tx[5],
        type: TxType.EIP155,
      }
      return {
        stateRoot: queueElement.stateRoot,
        isSequencerTx: true,
        sequencerTxType: TxType.EIP155,
        txData: dummyTx,
        timestamp: queueElement.timestamp,
        blockNumber: queueElement.blockNumber,
      }
    }
    if (
      timestamp < queueElement.timestamp &&
      blockNumber < queueElement.blockNumber
    ) {
      this.log.error('A deposit seems to have been skipped!')
      throw new Error('Skipped deposit?!')
    }
    throw new Error('Unable to fix queue element!')
  }

  private async _getSequencerBatchParams(
    shouldStartAtIndex: number,
    blocks: Batch
  ): Promise<AppendSequencerBatchParams> {
    const totalElementsToAppend = blocks.length

    // Generate contexts
    const contexts: BatchContext[] = []
    let lastBlockIsSequencerTx = false
    let lastTimestamp = 0
    let lastBlockNumber = 0
    const groupedBlocks: Array<{
      sequenced: BatchElement[]
      queued: BatchElement[]
    }> = []
    for (const block of blocks) {
      if (
        (lastBlockIsSequencerTx === false && block.isSequencerTx === true) ||
        groupedBlocks.length === 0 ||
        (block.timestamp !== lastTimestamp && block.isSequencerTx === true) ||
        (block.blockNumber !== lastBlockNumber && block.isSequencerTx === true)
      ) {
        groupedBlocks.push({
          sequenced: [],
          queued: [],
        })
      }
      const cur = groupedBlocks.length - 1
      block.isSequencerTx
        ? groupedBlocks[cur].sequenced.push(block)
        : groupedBlocks[cur].queued.push(block)
      lastBlockIsSequencerTx = block.isSequencerTx
      lastTimestamp = block.timestamp
      lastBlockNumber = block.blockNumber
    }
    for (const groupedBlock of groupedBlocks) {
      if (
        groupedBlock.sequenced.length === 0 &&
        groupedBlock.queued.length === 0
      ) {
        throw new Error(
          'Attempted to generate batch context with 0 queued and 0 sequenced txs!'
        )
      }
      contexts.push({
        numSequencedTransactions: groupedBlock.sequenced.length,
        numSubsequentQueueTransactions: groupedBlock.queued.length,
        timestamp:
          groupedBlock.sequenced.length > 0
            ? groupedBlock.sequenced[0].timestamp
            : groupedBlock.queued[0].timestamp,
        blockNumber:
          groupedBlock.sequenced.length > 0
            ? groupedBlock.sequenced[0].blockNumber
            : groupedBlock.queued[0].blockNumber,
      })
    }

    // Generate sequencer transactions
    const transactions: string[] = []
    for (const block of blocks) {
      if (!block.isSequencerTx) {
        continue
      }
      let encoding: string
      if (block.sequencerTxType === TxType.EIP155) {
        encoding = ctcCoder.eip155TxData.encode(block.txData as EIP155TxData)
      } else if (block.sequencerTxType === TxType.EthSign) {
        encoding = ctcCoder.ethSignTxData.encode(block.txData as EthSignTxData)
      } else {
        throw new Error(
          `Trying to build batch with unknown type ${block.sequencerTxType}`
        )
      }
      transactions.push(encoding)
    }

    return {
      // TODO: Remove BLOCK_OFFSET by adding a tx to Geth's genesis
      shouldStartAtElement: shouldStartAtIndex - BLOCK_OFFSET,
      totalElementsToAppend,
      contexts,
      transactions,
    }
  }

  private async _getL2BatchElement(blockNumber: number): Promise<BatchElement> {
    const block = await this._getBlock(blockNumber)
    const txType = block.transactions[0].txType

    if (this._isSequencerTx(block)) {
      if (txType === TxType.EIP155 || txType === TxType.EthSign) {
        return this._getDefaultEcdsaTxBatchElement(block)
      } else {
        throw new Error('Unsupported Tx Type!')
      }
    } else {
      return {
        stateRoot: block.stateRoot,
        isSequencerTx: false,
        sequencerTxType: undefined,
        txData: undefined,
        timestamp: block.timestamp,
        blockNumber: block.transactions[0].l1BlockNumber,
      }
    }
  }

  private async _getBlock(blockNumber: number): Promise<L2Block> {
    const block = (await this.l2Provider.getBlockWithTransactions(
      blockNumber
    )) as L2Block
    // Convert the tx type to a number
    block.transactions[0].txType = txTypePlainText[block.transactions[0].txType]
    block.transactions[0].queueOrigin =
      queueOriginPlainText[block.transactions[0].queueOrigin]
    // For now just set the l1BlockNumber based on the current l1 block number
    if (!block.transactions[0].l1BlockNumber) {
      block.transactions[0].l1BlockNumber = this.lastL1BlockNumber
    }
    return block
  }

  private _getDefaultEcdsaTxBatchElement(block: L2Block): BatchElement {
    const tx: TransactionResponse = block.transactions[0]
    const txData: EIP155TxData = {
      sig: {
        v: tx.v - this.l2ChainId * 2 - 8 - 27,
        r: tx.r,
        s: tx.s,
      },
      gasLimit: BigNumber.from(tx.gasLimit).toNumber(),
      gasPrice: BigNumber.from(tx.gasPrice).toNumber(),
      nonce: tx.nonce,
      target: tx.to ? tx.to : '00'.repeat(20),
      data: tx.data,
      type: block.transactions[0].txType,
    }
    return {
      stateRoot: block.stateRoot,
      isSequencerTx: true,
      sequencerTxType: block.transactions[0].txType,
      txData,
      timestamp: block.timestamp,
      blockNumber: block.transactions[0].l1BlockNumber,
    }
  }

  private _isSequencerTx(block: L2Block): boolean {
    return block.transactions[0].queueOrigin === QueueOrigin.Sequencer
  }
}
