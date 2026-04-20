import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChargePaymentSummary,
  PaymentSummary,
  SessionPaymentSummary
} from '../src/index.js';

test('payment summary union covers session and charge legs', () => {
  const session: SessionPaymentSummary = {
    kind: 'session',
    provider: 'openai-mpp',
    spent: '10',
    cumulative: '10'
  };

  const charge: ChargePaymentSummary = {
    kind: 'charge',
    provider: 'bookfold-mpp-server',
    amount: '42',
    currency: 'USD',
    status: 'paid'
  };

  const payments: PaymentSummary[] = [session, charge];

  assert.deepEqual(
    payments.map((payment) => payment.kind),
    ['session', 'charge']
  );
});
