import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkReturnEligibility,
  createReturnRequest,
  lookupOrder,
  searchPolicy,
} from '../src/tools/booklyTools'

test('lookupOrder requires at least one identifier', () => {
  assert.deepEqual(lookupOrder({}), {
    ok: false,
    error: 'An order ID or email is required to look up an order.',
  })
})

test('lookupOrder normalizes identifiers and requires all supplied identifiers to match', () => {
  assert.equal(lookupOrder({ orderId: ' b1001 ' }).ok, true)
  assert.equal(lookupOrder({ email: ' MIRA@EXAMPLE.COM ' }).ok, true)
  assert.equal(lookupOrder({ orderId: 'B1001', email: 'devon@example.com' }).ok, false)
})

test('checkReturnEligibility enforces delivery date, return window, item membership, and final sale', () => {
  assert.equal(checkReturnEligibility({ orderId: 'B1002', itemId: 'I-21' }).data?.eligible, true)
  assert.equal(checkReturnEligibility({ orderId: 'B1001', itemId: 'I-11' }).data?.eligible, false)
  assert.equal(checkReturnEligibility({ orderId: 'B1003', itemId: 'I-31' }).data?.eligible, false)
  assert.equal(checkReturnEligibility({ orderId: 'B1002', itemId: 'I-22' }).data?.eligible, false)
  assert.equal(checkReturnEligibility({ orderId: 'B1002', itemId: 'I-99' }).ok, false)
})

test('createReturnRequest validates its mutation boundary', () => {
  assert.equal(
    createReturnRequest({ orderId: 'B9999', itemId: 'I-99', reason: 'damaged' }).ok,
    false,
  )
  assert.equal(
    createReturnRequest({ orderId: 'B1002', itemId: 'I-99', reason: 'damaged' }).ok,
    false,
  )
  assert.equal(
    createReturnRequest({ orderId: 'B1002', itemId: 'I-22', reason: 'damaged' }).ok,
    false,
  )
  assert.equal(createReturnRequest({ orderId: 'B1002', itemId: 'I-21', reason: ' ' }).ok, false)
  assert.deepEqual(createReturnRequest({ orderId: ' b1002 ', itemId: ' i-21 ', reason: ' damaged ' }), {
    ok: true,
    data: {
      returnId: 'R-B1002-I-21',
      labelStatus: 'Return label emailed to the customer account address.',
    },
  })
})

test('searchPolicy returns grounded articles and rejects unknown topics', () => {
  assert.equal(searchPolicy({ topic: 'refund timing' }).data?.title, 'Refund timing')
  assert.equal(searchPolicy({ topic: 'price matching' }).ok, false)
})
