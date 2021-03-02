import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers'
import { BigNumber, Signer } from 'ethers'
import { arrayify, defaultAbiCoder, keccak256 } from 'ethers/lib/utils'

const wait = (milliseconds) => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const RETRY_JSON_REQUEST_LIMIT = 3

// More information about developing with ITX can be found here https://infura.io/docs/transactions
export async function sendTxWithITX(
  signer: Signer,
  to: string,
  data: string,
  gas: string,
  iteration = 0
): Promise<string> {
  try {
    const tx = {
      to,
      data,
      gas: BigNumber.from(gas)
        .add(50000)
        .toString(), // A little extra gas since we fetched it using estimateGas
    }

    const relayTransactionHashToSign = keccak256(
      defaultAbiCoder.encode(
        ['address', 'bytes', 'uint', 'uint'],
        [tx.to, tx.data, tx.gas, (await signer.provider.getNetwork()).chainId]
      )
    )
    const signature = await signer.signMessage(
      arrayify(relayTransactionHashToSign)
    )

    return await (signer.provider as JsonRpcProvider).send(
      'relay_sendTransaction',
      [tx, signature]
    )
  } catch (e) {
    // Take into account JSON RPC errors that may arise (e.g. rate limiting)

    if (iteration >= RETRY_JSON_REQUEST_LIMIT) {
      throw e
    }
    await wait(2000)

    // Let's try to send it again.
    return sendTxWithITX(signer, to, data, gas, iteration + 1)
  }
}
export async function itxWaitForTx(
  itx: JsonRpcProvider,
  relayTransactionHash: string,
  numConfirmations: number
): Promise<TransactionReceipt> {
  let iteration = 0

  while (true) {
    try {
      // fetch the latest ethereum transaction hashes
      const statusResponse = await itx.send('relay_getTransactionStatus', [
        relayTransactionHash,
      ])

      // check each of these hashes to see if their receipt exists and
      // has confirmations
      for (const broadcast of statusResponse) {
        const hashes = broadcast
        const receipt = await itx.getTransactionReceipt(hashes['ethTxHash'])

        if (
          receipt &&
          receipt.confirmations &&
          receipt.confirmations > numConfirmations
        ) {
          // The transaction is now on chain!
          this.log.info(`Ethereum transaction hash: ${receipt.transactionHash}`)
          return receipt
        }
      }
      await wait(3000)
    } catch (e) {
      // Take into account JSON RPC errors that may arise (e.g. rate limiting)
      if (iteration >= RETRY_JSON_REQUEST_LIMIT) {
        throw e
      }
      iteration = iteration + 1
      await wait(5000)
    }
  }
}
