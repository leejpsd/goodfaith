import { z } from 'zod';

const link = z.object({ rel: z.string(), href: z.string() });

export const paypalEvent = z.object({
  id: z.string(),
  event_type: z.string(),
  resource: z
    .object({
      id: z.string().optional(),
      links: z.array(link).optional(),
      supplementary_data: z.object({ related_ids: z.object({ authorization_id: z.string().optional() }).optional() }).optional(),
    })
    .loose(),
});
export type PayPalEvent = z.infer<typeof paypalEvent>;

export type Confirmation =
  | { confirmed: 'voided'; authorizationId: string }
  | { confirmed: 'captured'; captureId: string; authorizationId?: string }
  | { confirmed: 'refunded'; refundId: string; captureId: string };

// A refund's own `up` link is the only place the event names the capture it refunds.
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
