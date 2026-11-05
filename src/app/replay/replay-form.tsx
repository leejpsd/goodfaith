'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const MESSAGES: Record<string, string> = {
  bad_repo: 'Enter a public repository as owner/name, for example paypal/agent-toolkit.',
  not_found: 'That repository is not public, or it does not exist.',
  limit: 'The replay has reached its limit for today. Replays already run stay available.',
};

const EXAMPLES = ['paypal/agent-toolkit', 'scrapy/scrapy', 'scikit-learn/scikit-learn', 'godotengine/godot'];

export function ReplayForm() {
  const router = useRouter();
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start(target: string) {
    setBusy(true);
    setMessage(null);
    const response = await fetch('/api/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: target }) });
    const json = (await response.json().catch(() => ({}))) as { repo?: string; refused?: string };
    if (json.repo) {
      router.push(`/replay/${json.repo}`);
      return;
    }
    setBusy(false);
    setMessage(MESSAGES[json.refused ?? ''] ?? 'GitHub did not answer. Try again in a moment.');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void start(repo);
  }

  return (
    <>
      <form className="replay-form" onSubmit={submit}>
        <label htmlFor="repo">Public repository</label>
        <div>
          <input id="repo" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/name" autoComplete="off" spellCheck={false} />
          <button className="button primary" type="submit" disabled={busy || !repo.trim()}>Replay it</button>
        </div>
      </form>
      <p className="muted">Or try {EXAMPLES.map((example, index) => (
        <span key={example}>
          {index > 0 && ', '}
          <button className="link" type="button" disabled={busy} onClick={() => void start(example)}>{example}</button>
        </span>
      ))}.</p>
      {message && <p className="warn" role="alert">{message}</p>}
    </>
  );
}
