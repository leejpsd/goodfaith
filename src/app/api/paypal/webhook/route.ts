import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookDeliveries } from '@/db/schema';
import { paypalClient } from '@/lib/paypal/client';
import { paypalEvent } from '@/lib/paypal/webhook';
import { onPayPalEvent } from '@/server/hold-flow';
import { liveHoldDeps } from '@/server/live';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const raw = await request.text();
  const h = request.headers;
  const headers = {
    authAlgo: h.get('paypal-auth-algo') ?? '',
    certUrl: h.get('paypal-cert-url') ?? '',
    transmissionId: h.get('paypal-transmission-id') ?? '',
    transmissionSig: h.get('paypal-transmission-sig') ?? '',
    transmissionTime: h.get('paypal-transmission-time') ?? '',
  };
  if (Object.values(headers).some((v) => !v)) return new Response('bad signature', { status: 401 });

  let verified = false;
  try {
    verified = await paypalClient().verifyWebhook(headers, raw);
  } catch (error) {
    // PayPal retries a failed delivery, so an outage on the check does not lose the event.
    console.error('PayPal webhook check failed', error instanceof Error ? error.message : 'unknown error');
    return new Response('check failed', { status: 503 });
  }
  if (!verified) return new Response('bad signature', { status: 401 });

  const parsed = paypalEvent.safeParse(JSON.parse(raw));
  if (!parsed.success) return Response.json({ ignored: 'unreadable' });
  const event = parsed.data;

  const fresh = await db().insert(webhookDeliveries).values({ source: 'paypal', deliveryId: event.id }).onConflictDoNothing().returning();
  if (!fresh.length) return Response.json({ duplicate: true });

  try {
    await onPayPalEvent(liveHoldDeps(), event);
    return Response.json({ ok: true });
  } catch (error) {
    // Forget the delivery, so PayPal's retry can run it again.
    await db().delete(webhookDeliveries).where(and(eq(webhookDeliveries.source, 'paypal'), eq(webhookDeliveries.deliveryId, event.id)));
    console.error('PayPal webhook failed', event.id, error instanceof Error ? error.message : 'unknown error');
    return new Response('failed', { status: 500 });
  }
}
