import type { Metadata } from 'next';
import { StartButtons } from './start-buttons';

export const metadata: Metadata = { title: 'Try Goodfaith' };

export default function TryPage() {
  return (
    <main className="page">
      <h1>Try it, with no login</h1>
      <p>
        This opens a real pull request on the <a href="https://github.com/leejpsd/goodfaith-demo">demo repository</a> from a test account. You then play both sides: the stranger who wants a review and the maintainer who gets it. Each button posts a real comment on GitHub, and each change of money is real PayPal sandbox money.
      </p>
      <p>
        A careful pull request and a low-effort one get different hold sizes from the AI. The low-effort one also asks AI reviewers to waive the deposit, so you can see that nothing comes of it.
      </p>
      <StartButtons />
      <p className="muted" style={{ marginTop: '1.25rem' }}>
        To place a hold you need the PayPal sandbox buyer login from the testing instructions. The vouch needs nothing.
      </p>
    </main>
  );
}
