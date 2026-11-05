import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { z } from 'zod';
import { ACTIONS, type TryAction } from '@/lib/demo/actions';
import { runTryAction, tryState } from '@/server/try-flow';

export const dynamic = 'force-dynamic';

const input = z.object({ action: z.enum(Object.keys(ACTIONS) as [TryAction, ...TryAction[]]) });
const readNumber = (value: string) => (/^\d{1,7}$/.test(value) ? Number(value) : null);

export async function GET(_request: Request, context: { params: Promise<{ number: string }> }) {
  const number = readNumber((await context.params).number);
  const state = number === null ? null : await tryState(number);
  return state ? Response.json(state) : Response.json({ refused: 'not_found' }, { status: 404 });
}

export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  if (!fromThisSite(request)) return notFromThisSite();
  const number = readNumber((await context.params).number);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (number === null || !parsed.success) return Response.json({ refused: 'bad_request' }, { status: 400 });
  try {
    const result = await runTryAction(number, parsed.data.action);
    return result === 'ok' ? Response.json({ ok: true }) : Response.json({ refused: result }, { status: result === 'not_found' ? 404 : 409 });
  } catch (error) {
    console.error('Try action failed', number, parsed.data.action, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
