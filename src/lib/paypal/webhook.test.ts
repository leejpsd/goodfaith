import { describe, expect, it } from 'vitest';
import { readConfirmation, readDispute, readPayout, type PayPalEvent } from './webhook';

const event = (event_type: string, resource: PayPalEvent['resource']): PayPalEvent => ({ id: 'WH-1', event_type, resource });

describe('readConfirmation', () => {
  it('reads a void', () => {
    expect(readConfirmation(event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'A1' }))).toEqual({ confirmed: 'voided', authorizationId: 'A1' });
  });

  it('reads a capture and its authorization', () => {
    expect(
      readConfirmation(event('PAYMENT.CAPTURE.COMPLETED', { id: 'C1', supplementary_data: { related_ids: { authorization_id: 'A1' } } })),
    ).toEqual({ confirmed: 'captured', captureId: 'C1', authorizationId: 'A1' });
  });

  it('reads what PayPal left after its fee', () => {
    const resource = { id: 'C1', seller_receivable_breakdown: { gross_amount: { value: '25.00' }, paypal_fee: { value: '1.22' }, net_amount: { value: '23.78' } } };
    expect(readConfirmation(event('PAYMENT.CAPTURE.COMPLETED', resource))).toMatchObject({ captureId: 'C1', netCents: 2378 });
  });

  it('falls back to the up link for the authorization', () => {
    expect(
      readConfirmation(event('PAYMENT.CAPTURE.COMPLETED', { id: 'C1', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/authorizations/A2' }] })),
    ).toEqual({ confirmed: 'captured', captureId: 'C1', authorizationId: 'A2' });
  });

  it.each(['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'])('reads %s through the up link', (type) => {
    expect(readConfirmation(event(type, { id: 'R1', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/C1' }] }))).toEqual({
      confirmed: 'refunded',
      refundId: 'R1',
      captureId: 'C1',
    });
  });

  it('ignores a refund with no capture link', () => {
    expect(readConfirmation(event('PAYMENT.CAPTURE.REFUNDED', { id: 'R1' }))).toBeNull();
  });

  it('ignores other event types and missing IDs', () => {
    expect(readConfirmation(event('PAYMENT.AUTHORIZATION.CREATED', { id: 'A1' }))).toBeNull();
    expect(readConfirmation(event('PAYMENT.AUTHORIZATION.VOIDED', {}))).toBeNull();
  });
});

describe('readDispute', () => {
  const resource = { dispute_id: 'D1', disputed_transactions: [{ seller_transaction_id: 'C1' }], dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } };

  it('reads an opened and a resolved dispute', () => {
    expect(readDispute(event('CUSTOMER.DISPUTE.CREATED', resource))).toMatchObject({ phase: 'opened', disputeId: 'D1', captureId: 'C1' });
    expect(readDispute(event('CUSTOMER.DISPUTE.RESOLVED', resource))).toMatchObject({ phase: 'resolved', outcome: 'RESOLVED_SELLER_FAVOUR' });
  });

  it('ignores other events and a dispute with no capture', () => {
    expect(readDispute(event('CUSTOMER.DISPUTE.UPDATED', resource))).toBeNull();
    expect(readDispute(event('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'D1' }))).toBeNull();
  });
});

describe('readPayout', () => {
  it('waits on an unclaimed payout, which PayPal returns after 30 days if nobody claims it', () => {
    expect(readPayout(event('PAYMENT.PAYOUTS-ITEM.UNCLAIMED', { payout_batch_id: 'B1' }))).toBeNull();
    expect(readPayout(event('PAYMENT.PAYOUTS-ITEM.RETURNED', { payout_batch_id: 'B1' }))).toEqual({ batchId: 'B1', outcome: 'failed' });
    expect(readPayout(event('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_batch_id: 'B1' }))).toEqual({ batchId: 'B1', outcome: 'succeeded' });
  });
});
