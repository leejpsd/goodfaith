import type { Metadata } from 'next';
import { ReplayView } from './replay-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Replay' };

export default async function ReplayRepoPage({ params }: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await params;
  return (
    <main className="page wide">
      <ReplayView owner={owner} name={name} />
    </main>
  );
}
