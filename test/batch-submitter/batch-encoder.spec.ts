import '../setup'

/* Internal Imports */
import { ctcCoder } from '../../src'
import { expect } from 'chai'

describe('BatchEncoder', () => {
  describe('eip155TxData', () => {
    it('should encode & then decode to the correct value', () => {
      const eip155TxData = {
        sig: {
          v: '01',
          r: '11'.repeat(32),
          s: '22'.repeat(32),
        },
        gasLimit: 500,
        gasPrice: 100,
        nonce: 100,
        target: '12'.repeat(20),
        data: '99'.repeat(10),
      }
      const encoded = ctcCoder.eip155TxData.encode(eip155TxData)
      const decoded = ctcCoder.eip155TxData.decode(encoded)
      expect(eip155TxData).to.deep.equal(decoded)
    })
  })

  describe('ethSignTxData', () => {
    it('should encode & then decode to the correct value', () => {
      const ethSignTxData = {
        sig: {
          v: '00',
          r: '33'.repeat(32),
          s: '44'.repeat(32),
        },
        gasLimit: 250,
        gasPrice: 123,
        nonce: 600,
        target: '52'.repeat(20),
        data: '09'.repeat(10),
      }
      const encoded = ctcCoder.ethSignTxData.encode(ethSignTxData)
      const decoded = ctcCoder.ethSignTxData.decode(encoded)
      expect(ethSignTxData).to.deep.equal(decoded)
    })
  })
})
