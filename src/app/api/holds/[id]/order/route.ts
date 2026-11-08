import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { beginHold, type Refusal } from '@/server/hold-flow';
import { liveHoldDeps } from '@/server/live';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL_STATUS: Record<Refusal, number> = { not_found: 404, not_waiting: 409, stale_order: 409, declined: 422, not_approved: 422, pending: 409, too_many_holds: 409, sizing: 409 };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!fromThisSite(request)) return notFromThisSite();
  const { id } = await context.params;
  if (!UUID.test(id)) return Response.json({ refused: 'not_found' }, { status: 404 });
  try {
    const result = await beginHold(liveHoldDeps(), id);
    return 'refused' in result ? Response.json(result, { status: REFUSAL_STATUS[result.refused] }) : Response.json(result);
  } catch (error) {
    console.error('Order failed', id, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
