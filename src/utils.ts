/* External Imports */
import { JsonRpcProvider, TransactionReceipt } from "@ethersproject/providers";
import { BigNumber, Signer, Wallet } from "ethers";
import { arrayify, defaultAbiCoder, keccak256 } from "ethers/lib/utils";

const RETRY_LIMIT = 3;

export const getLen = (pos: { start; end }) => (pos.end - pos.start) * 2;

export const encodeHex = (val: any, len: number) =>
  remove0x(BigNumber.from(val).toHexString()).padStart(len, "0");

export const toVerifiedBytes = (val: string, len: number) => {
  val = remove0x(val);
  if (val.length !== len) {
    throw new Error("Invalid length!");
  }
  return val;
};

export const remove0x = (str: string): string => {
  if (str.startsWith("0x")) {
    return str.slice(2);
  } else {
    return str;
  }
};

const wait = (milliseconds) => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export async function sendTxWithITX(
  itx: JsonRpcProvider,
  signer: Signer,
  to: string,
  data: string,
  gas: string,
  iteration = 0
): Promise<string> {
  try {
    const tx = {
      to: to,
      data: data,
      gas: BigNumber.from(gas).add(50000).toString(), // A little extra gas since we fetched it using estimateGas
    };

    const relayTransactionHashToSign = keccak256(
      defaultAbiCoder.encode(
        ["address", "bytes", "uint", "uint"],
        [tx.to, tx.data, tx.gas, (await itx.getNetwork()).chainId]
      )
    );
    const signature = await signer.signMessage(
      arrayify(relayTransactionHashToSign)
    );

    return await itx.send("relay_sendTransaction", [tx, signature]);
  } catch (e) {
    // Take into account JSON RPC errors that may arise (e.g. rate limiting)

    if (iteration === RETRY_LIMIT) {
      throw e;
    }
    await wait(2000);

    // Let's try to send it again.
    return await sendTxWithITX(itx, signer, to, data, gas, iteration + 1);
  }
}
export async function itxWaitForTx(
  itx: JsonRpcProvider,
  relayTransactionHash: string
): Promise<TransactionReceipt> {
  let iteration = 0;

  while (true) {
    try {
      // fetch the latest ethereum transaction hashes
      const statusResponse = await itx.send("relay_getTransactionStatus", [
        relayTransactionHash,
      ]);

      // check each of these hashes to see if their receipt exists and
      // has confirmations
      for (let i = 0; i < statusResponse.length; i++) {
        const hashes = statusResponse[i];
        const receipt = await itx.getTransactionReceipt(hashes["ethTxHash"]);

        if (receipt && receipt.confirmations && receipt.confirmations > 1) {
          // The transaction is now on chain!
          this.log.info(
            `Ethereum transaction hash: ${receipt.transactionHash}`
          );
          return;
        }
      }
      await wait(3000);
    } catch (e) {
      // Take into account JSON RPC errors that may arise (e.g. rate limiting)
      if (iteration === RETRY_LIMIT) {
        throw e;
      }
      iteration = iteration + 1;
      await wait(5000);
    }
  }
}
