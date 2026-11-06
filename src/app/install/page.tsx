import type { Metadata } from 'next';
import Link from 'next/link';
import { InstallCheckForm } from './install-check';
import { SettingsBuilder } from './settings-builder';

export const metadata: Metadata = { title: 'Install Goodfaith' };

export default function InstallPage() {
  const installUrl = `https://github.com/apps/${process.env.GITHUB_APP_SLUG ?? 'goodfaith-gate'}/installations/new`;
  return (
    <main className="page">
      <h1>Put Goodfaith on a repository</h1>
      <p className="lede">Install the GitHub App, set your bounds in one file, and the next stranger&apos;s pull request meets the two doors: a free vouch, or a refundable PayPal hold.</p>
      <p className="card">
        <strong>Use a test repository.</strong> This hosted Goodfaith runs on PayPal&apos;s sandbox for the PayPal AI Hackathon, so a hold there needs a PayPal sandbox account and no real money moves. A live install needs its own PayPal app, as the <a href="https://github.com/leejpsd/goodfaith#run-it-locally">README</a> describes.
      </p>

      <ol className="steps install-steps">
        <li>
          <div>
            <h2>Install the app</h2>
            <p>Choose the repositories it may act on. It writes a check, comments and a label on a stranger&apos;s pull request, and closes one only when a maintainer forfeits. It reads that pull request&apos;s diff for the AI&apos;s brief, and two files: <code>.github/goodfaith.json</code> and <code>.github/VOUCHED.td</code>.</p>
            <a className="button primary" href={installUrl}>Install on GitHub</a>
          </div>
        </li>
        <li>
          <div>
            <h2>Set the bounds</h2>
            <p>Maintainers set them in the repository, through the same review as any other change, and anyone can read them. Without a file, the defaults below apply.</p>
            <SettingsBuilder />
            <p className="muted">Already use <a href="https://github.com/mitchellh/vouch">mitchellh/vouch</a>? Goodfaith reads the same <code>.github/VOUCHED.td</code>, so the people on it skip the gate.</p>
          </div>
        </li>
        <li>
          <div>
            <h2>Check it</h2>
            <p>Goodfaith reads what the gate will read on the next stranger&apos;s pull request, and says what it found. Anyone can run this check, so it reads public repositories only, and a private one shows as not installed.</p>
            <InstallCheckForm installUrl={installUrl} />
          </div>
        </li>
      </ol>

      <section className="card">
        <h2>Then</h2>
        <p>A stranger&apos;s pull request gets a check and one comment with both doors. A maintainer answers with <code>!vouch</code>, a review, or <code>!forfeit &lt;reason&gt;</code>, and every step lands on the <Link href="/ledger">public ledger</Link>. To see both sides first without installing anything, <Link href="/try">try it on the demo repository</Link>.</p>
      </section>
    </main>
  );
}
