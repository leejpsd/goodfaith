import { readRepo } from '@/lib/replay/replay';
import { readReplay } from '@/server/replay-flow';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await context.params;
  const repo = readRepo(`${owner}/${name}`);
  const row = repo ? await readReplay(repo) : null;
  return row ? Response.json({ status: row.status, result: row.result }) : Response.json({ refused: 'not_found' }, { status: 404 });
}
