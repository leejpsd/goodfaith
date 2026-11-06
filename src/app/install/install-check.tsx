'use client';

import { useState, type FormEvent } from 'react';
import type { ProjectSettings } from '@/lib/github/config';
import type { InstallCheck } from '@/server/install-flow';

const MESSAGES: Record<string, string> = {
  bad_repo: 'Enter a repository as owner/name.',
  limit: 'Too many checks for now. Try again in a while.',
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function describe(s: ProjectSettings): string {
  const paid = s.payoutReceiver ? `a forfeit is paid to ${s.payoutReceiver}` : 'no forfeit is paid out, so a capture stays refundable';
  const trust = s.trustEarned ? 'a newcomer merged through Goodfaith elsewhere gets in free' : 'trust from other projects is off';
  return `Holds run from ${usd(s.minCents)} to ${usd(s.maxCents)}, usually ${usd(s.defaultCents)}. An author has ${s.appealDays === 1 ? '1 day' : `${s.appealDays} days`} to appeal a forfeit, ${paid}, and ${trust}.`;
}

// Reads what the gate will read on the next stranger's pull request.
export function InstallCheckForm({ installUrl }: { installUrl: string }) {
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(InstallCheck & { repo: string }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setResult(null);
    const response = await fetch('/api/install/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }) }).catch(() => null);
    const json = ((await response?.json().catch(() => null)) ?? {}) as Partial<InstallCheck & { repo: string; refused: string }>;
    setBusy(false);
    if (json.repo && json.settings) setResult(json as InstallCheck & { repo: string });
    else setMessage(MESSAGES[json.refused ?? ''] ?? 'GitHub did not answer. Try again in a moment.');
  }

  return (
    <>
      <form className="replay-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="check-repo">Repository</label>
        <div>
          <input id="check-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" autoComplete="off" spellCheck={false} />
          <button className="button primary" type="submit" disabled={busy || !repo.trim()}>{busy ? 'Checking' : 'Check it'}</button>
        </div>
      </form>
      {message && <p className="warn" role="alert">{message}</p>}
      {result && (
        <ul className="check-result" aria-live="polite">
          {result.installed ? (
            <>
              <li><strong>Installed</strong> on {result.repo}.</li>
              <li>
                {result.settings.found
                  ? result.settings.problems.length
                    ? <><strong className="warn">The settings file is ignored.</strong> {result.settings.problems.join(' ')} Until it is fixed: {describe(result.settings.applied)}</>
                    : <><strong>Settings read.</strong> {describe(result.settings.applied)}</>
                  : <><strong>No settings file yet</strong>, so the defaults apply. {describe(result.settings.applied)}</>}
              </li>
              <li>
                {result.vouchList.found
                  ? <><strong>Vouch list read.</strong> It names {result.vouchList.vouched} vouched and {result.vouchList.denounced} denounced accounts, who skip the gate or never pass it.</>
                  : <><strong>No vouch list</strong>, which is fine. A maintainer&apos;s <code>!vouch</code> adds people as they come.</>}
              </li>
              <li>Next, open a pull request from an account without write access to {result.repo}, and the gate answers it.</li>
            </>
          ) : (
            <li><strong className="warn">Not installed on {result.repo}.</strong> <a href={installUrl}>Install the app</a> and choose this repository, then check again.</li>
          )}
        </ul>
      )}
    </>
  );
}
