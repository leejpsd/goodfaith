import { describe, expect, it } from 'vitest';
import { readConfirmation, type PayPalEvent } from './webhook';

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
