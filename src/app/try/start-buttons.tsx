'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const MESSAGES: Record<string, string> = {
  limit: 'The demo has reached its limit of new pull requests for today. The existing ones are on the public ledger.',
  disabled: 'The demo accounts are not set up on this server.',
};

export function StartButtons() {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start(kind: 'careful' | 'low_effort') {
    setOpening(true);
    setMessage(null);
    const response = await fetch('/api/try', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
    const json = (await response.json().catch(() => ({}))) as { number?: number; refused?: string };
    if (json.number) {
      router.push(`/try/${json.number}`);
      return;
    }
    setOpening(false);
    setMessage(MESSAGES[json.refused ?? ''] ?? 'GitHub did not accept the pull request. Try again in a moment.');
  }

  return (
    <>
      <div className="actions">
        <button className="button primary" type="button" disabled={opening} onClick={() => void start('careful')}>Open a careful pull request</button>
        <button className="button" type="button" disabled={opening} onClick={() => void start('low_effort')}>Open a low-effort pull request</button>
      </div>
      {opening && <p className="muted" role="status">Opening a real pull request on GitHub.</p>}
      {message && <p className="warn" role="alert">{message}</p>}
    </>
  );
}
