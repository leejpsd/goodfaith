import { z } from 'zod';
import { fromThisSite, notFromThisSite } from '@/lib/http/same-origin';
import { readRepo } from '@/lib/replay/replay';
import { checkInstall } from '@/server/install-flow';

export const dynamic = 'force-dynamic';

const input = z.object({ repo: z.string().max(200) });
const PER_VISITOR_HOURLY_LIMIT = 30;
const visitors = new Map<string, { hour: number; used: number }>();

function overVisitorLimit(request: Request): boolean {
  const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const hour = Math.floor(Date.now() / 36e5);
  const entry = visitors.get(visitor);
  if (!entry || entry.hour !== hour) {
    if (visitors.size > 5000) visitors.clear();
    visitors.set(visitor, { hour, used: 1 });
    return false;
  }
  entry.used += 1;
  return entry.used > PER_VISITOR_HOURLY_LIMIT;
}

export async function POST(request: Request) {
  if (!fromThisSite(request)) return notFromThisSite();
  const parsed = input.safeParse(await request.json().catch(() => null));
  const repo = parsed.success ? readRepo(parsed.data.repo) : null;
  if (!repo) return Response.json({ refused: 'bad_repo' }, { status: 400 });
  if (overVisitorLimit(request)) return Response.json({ refused: 'limit' }, { status: 429 });
  try {
    const [owner, name] = repo.split('/') as [string, string];
    const result = await checkInstall(owner, name);
    return 'refused' in result ? Response.json(result, { status: 429 }) : Response.json({ ...result, repo });
  } catch (error) {
    console.error('Install check failed', repo, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ refused: 'unavailable' }, { status: 502 });
  }
}
