import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { z } from 'zod';
import { confirmHold, type Refusal } from '@/server/hold-flow';
import { liveHoldDeps } from '@/server/live';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL_STATUS: Record<Refusal, number> = { not_found: 404, not_waiting: 409, stale_order: 409, declined: 422, too_many_holds: 409 };
const input = z.object({ orderId: z.string().min(1).max(64), simulateDecline: z.boolean().optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!fromThisSite(request)) return notFromThisSite();
  const { id } = await context.params;
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!UUID.test(id) || !parsed.success) return Response.json({ refused: 'not_found' }, { status: 404 });
  try {
    const result = await confirmHold(liveHoldDeps(), id, parsed.data.orderId, { simulateDecline: parsed.data.simulateDecline });
    return 'refused' in result ? Response.json(result, { status: REFUSAL_STATUS[result.refused] }) : Response.json(result);
  } catch (error) {
    console.error('Authorize failed', id, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
