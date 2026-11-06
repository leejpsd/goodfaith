'use client';

import { useState } from 'react';
import { checkSettings, MAX_ALLOWED_CENTS, MIN_ALLOWED_CENTS } from '@/lib/github/config';

const toCents = (dollars: string) => Math.round(Number(dollars) * 100);
const REPO = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d._-]{1,100}$/i;
const readRepo = (input: string) => {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  return REPO.test(trimmed) ? trimmed : null;
};

// Builds .github/goodfaith.json, and checks it with the same reading the gate uses.
export function SettingsBuilder() {
  const [min, setMin] = useState('2');
  const [usual, setUsual] = useState('5');
  const [max, setMax] = useState('25');
  const [appealDays, setAppealDays] = useState('7');
  const [receiver, setReceiver] = useState('');
  const [trust, setTrust] = useState(true);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [copied, setCopied] = useState(false);

  const file = JSON.stringify(
    {
      min_cents: toCents(min),
      default_cents: toCents(usual),
      max_cents: toCents(max),
      appeal_days: Number(appealDays),
      payout_receiver: receiver.trim() || null,
      trust_earned_elsewhere: trust,
    },
    null,
    2,
  );
  const { problems } = checkSettings(file);
  const target = readRepo(repo);
  const propose = target && branch.trim() ? `https://github.com/${target}/new/${encodeURIComponent(branch.trim())}?filename=.github/goodfaith.json&value=${encodeURIComponent(`${file}\n`)}` : null;

  async function copy() {
    await navigator.clipboard.writeText(`${file}\n`);
    setCopied(true);
  }

  return (
    <div className="settings">
      <div className="settings-form">
        <label>
          Smallest hold, in dollars
          <input type="number" inputMode="decimal" min={MIN_ALLOWED_CENTS / 100} max={MAX_ALLOWED_CENTS / 100} step="1" value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
        <label>
          Usual hold
          <input type="number" inputMode="decimal" min={MIN_ALLOWED_CENTS / 100} max={MAX_ALLOWED_CENTS / 100} step="1" value={usual} onChange={(e) => setUsual(e.target.value)} />
        </label>
        <label>
          Largest hold
          <input type="number" inputMode="decimal" min={MIN_ALLOWED_CENTS / 100} max={MAX_ALLOWED_CENTS / 100} step="1" value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
        <label>
          Days to appeal a forfeit
          <input type="number" min="1" max="14" step="1" value={appealDays} onChange={(e) => setAppealDays(e.target.value)} />
        </label>
        <label className="wide">
          Where a forfeit is paid, a PayPal email. Leave it empty and nothing is paid out
          <input type="email" value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="maintainers@example.com" autoComplete="off" />
        </label>
        <label className="check wide">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          Let in, for free, a newcomer whose pull request was merged through Goodfaith at another project
        </label>
      </div>
      <p className="muted">The AI picks low, medium or high, and code turns that into the smallest, usual or largest hold. It can never name another amount.</p>
      <pre className="settings-file" aria-label="The settings file">{`// .github/goodfaith.json\n${file}`}</pre>
      {problems.length > 0 ? (
        <ul className="warn" role="alert">
          {problems.map((problem) => <li key={problem}>{problem} Goodfaith would ignore this file.</li>)}
        </ul>
      ) : (
        <div className="settings-actions">
          <button className="button" type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy the file'}</button>
          <div className="replay-form">
            <label htmlFor="propose-repo">Or open it on GitHub as a new file</label>
            <div>
              <input id="propose-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" autoComplete="off" spellCheck={false} />
              <input aria-label="Branch" className="branch" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
              {propose ? <a className="button primary" href={propose}>Open on GitHub</a> : <span className="button disabled" aria-disabled="true">Open on GitHub</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
