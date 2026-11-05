import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { z } from 'zod';
import { startTry } from '@/server/try-flow';

export const dynamic = 'force-dynamic';

const input = z.object({ kind: z.enum(['careful', 'low_effort']) });

export async function POST(request: Request) {
  if (!fromThisSite(request)) return notFromThisSite();
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ refused: 'bad_request' }, { status: 400 });
  try {
    const result = await startTry(parsed.data.kind);
    return 'refused' in result ? Response.json(result, { status: 429 }) : Response.json(result);
  } catch (error) {
    console.error('Try page could not open a pull request', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
