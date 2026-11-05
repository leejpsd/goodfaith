import { z } from 'zod';
import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { readRepo } from '@/lib/replay/replay';
import { startReplay } from '@/server/replay-flow';

export const dynamic = 'force-dynamic';

const input = z.object({ repo: z.string().max(200) });

export async function POST(request: Request) {
  if (!fromThisSite(request)) return notFromThisSite();
  const parsed = input.safeParse(await request.json().catch(() => null));
  const repo = parsed.success ? readRepo(parsed.data.repo) : null;
  if (!repo) return Response.json({ refused: 'bad_repo' }, { status: 400 });
  try {
    const result = await startReplay(repo);
    return 'refused' in result ? Response.json(result, { status: result.refused === 'limit' ? 429 : 404 }) : Response.json({ ...result, repo });
  } catch (error) {
    console.error('Replay could not start', repo, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
