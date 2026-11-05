import type { Metadata } from 'next';
import { TryConsole } from './try-console';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Try Goodfaith' };

export default async function TryRunPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return (
    <main className="page">
      <TryConsole number={number} />
    </main>
  );
}
