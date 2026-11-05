import type { Metadata } from 'next';
import { ReplayForm } from './replay-form';

export const metadata: Metadata = { title: 'Replay a repository' };

export default function ReplayPage() {
  return (
    <main className="page">
      <h1>What would have happened on your project?</h1>
      <p>
        Enter a public repository. Goodfaith reads its recent pull requests from people new to the project, and shows what the AI would have suggested for each, beside what the maintainers really did.
      </p>
      <ReplayForm />
      <p className="muted" style={{ marginTop: '1.25rem' }}>
        This only reads public data. It needs no install, it never comments or labels anything, and it shows no usernames. It takes about a minute for a repository nobody has replayed yet.
      </p>
    </main>
  );
}
