/* External Imports */
import chai = require('chai')
import spies from 'chai-spies'
import Mocha from 'mocha'

const should = chai.should()
const expect = chai.expect
chai.use(spies)

export { should, expect, chai, Mocha }
