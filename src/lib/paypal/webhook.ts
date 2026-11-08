import { z } from 'zod';
import { fromPayPalValue } from '@/lib/hold';

const link = z.object({ rel: z.string(), href: z.string() });

export const paypalEvent = z.object({
  id: z.string(),
  event_type: z.string(),
  resource: z
    .object({
      id: z.string().optional(),
      links: z.array(link).optional(),
      supplementary_data: z.object({ related_ids: z.object({ authorization_id: z.string().optional() }).optional() }).optional(),
      payout_batch_id: z.string().optional(),
    })
    .loose(),
});
export type PayPalEvent = z.infer<typeof paypalEvent>;

// A capture can come back pending and be refused later, and no money reached the project then.
export function readRefusedCapture(event: PayPalEvent): string | null {
  return (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') && event.resource.id ? event.resource.id : null;
}

const disputeResource = z
  .object({
    dispute_id: z.string(),
    disputed_transactions: z.array(z.object({ seller_transaction_id: z.string().optional() })).optional(),
    dispute_outcome: z.object({ outcome_code: z.string().optional() }).optional(),
  })
  .loose();

// A contributor can dispute a capture at PayPal, whatever the maintainers decided.
export function readDispute(event: PayPalEvent): { phase: 'opened' | 'resolved'; disputeId: string; captureId: string; outcome?: string } | null {
  const phase = event.event_type === 'CUSTOMER.DISPUTE.CREATED' ? 'opened' : event.event_type === 'CUSTOMER.DISPUTE.RESOLVED' ? 'resolved' : null;
  if (!phase) return null;
  const parsed = disputeResource.safeParse(event.resource);
  const captureId = parsed.success ? parsed.data.disputed_transactions?.[0]?.seller_transaction_id : undefined;
  if (!parsed.success || !captureId) return null;
  return { phase, disputeId: parsed.data.dispute_id, captureId, outcome: parsed.data.dispute_outcome?.outcome_code };
}

export type Confirmation =
  | { confirmed: 'voided'; authorizationId: string }
  | { confirmed: 'captured'; captureId: string; authorizationId?: string; netCents?: number }
  | { confirmed: 'refunded'; refundId: string; captureId: string };

// A refund's own `up` link is the only place the event names the capture it refunds.
const breakdown = z.object({ seller_receivable_breakdown: z.object({ net_amount: z.object({ value: z.string() }) }) });

const upTo = (event: PayPalEvent, kind: string) =>
  event.resource.links?.find((l) => l.rel === 'up' && l.href.includes(`/${kind}/`))?.href.split('/').pop();

export function readConfirmation(event: PayPalEvent): Confirmation | null {
  const id = event.resource.id;
  if (!id) return null;
  switch (event.event_type) {
    case 'PAYMENT.AUTHORIZATION.VOIDED':
      return { confirmed: 'voided', authorizationId: id };
    case 'PAYMENT.CAPTURE.COMPLETED':
      return {
        confirmed: 'captured',
        captureId: id,
        authorizationId: event.resource.supplementary_data?.related_ids?.authorization_id ?? upTo(event, 'authorizations'),
        netCents: fromPayPalValue(breakdown.safeParse(event.resource).data?.seller_receivable_breakdown.net_amount.value),
      };
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const captureId = upTo(event, 'captures');
      return captureId ? { confirmed: 'refunded', refundId: id, captureId } : null;
    }
    default:
      return null;
  }
}

// UNCLAIMED is left out on purpose: the receiver has 30 days to claim it, after which PayPal
// returns the money and sends RETURNED, which is the failure to act on.
const PAYOUT_FAILED = new Set(['FAILED', 'BLOCKED', 'DENIED', 'RETURNED', 'REFUNDED', 'REVERSED', 'CANCELED']);

// Payouts report per item. A final status other than success leaves the money with this app.
export function readPayout(event: PayPalEvent): { batchId: string; outcome: 'succeeded' | 'failed' } | null {
  const match = event.event_type.match(/^PAYMENT\.PAYOUTS-ITEM\.([A-Z]+)$/);
  const batchId = event.resource.payout_batch_id;
  if (!match?.[1] || !batchId) return null;
  if (match[1] === 'SUCCEEDED') return { batchId, outcome: 'succeeded' };
  return PAYOUT_FAILED.has(match[1]) ? { batchId, outcome: 'failed' } : null;
}
