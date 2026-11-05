'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { summarize, type ReplayResult } from '@/lib/replay/replay';

const money = (cents: number | null) => (cents === null ? 'none' : `$${(cents / 100).toFixed(2)}`);
const OUTCOME = { merged: 'Merged', closed: 'Closed, not merged', open: 'Still open' } as const;
const BAND = { low: 'Low', medium: 'Medium', high: 'High' } as const;

export function ReplayView({ owner, name }: { owner: string; name: string }) {
  const [status, setStatus] = useState<'running' | 'done' | 'failed' | 'missing'>('running');
  const [result, setResult] = useState<ReplayResult | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const response = await fetch(`/api/replay/${owner}/${name}`, { cache: 'no-store' }).catch(() => null);
      if (!live) return;
      if (response?.status === 404) {
        setStatus('missing');
        return;
      }
      const json = (await response?.json().catch(() => null)) as { status: 'running' | 'done' | 'failed'; result: ReplayResult | null } | null;
      if (json) {
        setStatus(json.status);
        setResult(json.result);
        if (json.status !== 'running') return;
      }
      timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [owner, name]);

  const title = `${owner}/${name}`;
  if (status === 'missing') return <><h1>{title}</h1><p>Nobody has replayed this repository yet. <Link href="/replay">Start a replay</Link>.</p></>;
  if (status === 'failed') return <><h1>{title}</h1><p className="warn">GitHub or the model did not finish this replay, and nothing was saved. <Link href="/replay">Try again</Link>.</p></>;
  if (!result) return <><h1>{title}</h1><p className="muted" role="status">Reading recent pull requests from people new to this project. This takes about a minute.</p></>;

  const s = summarize(result.rows);
  return (
    <>
      <h1>{title}</h1>
      <p className="muted">
        A read-only replay. <strong>This project has not installed Goodfaith and knows nothing about it.</strong> It uses the demo&apos;s $2, $5 and $25 amounts, read only what was public when each pull request opened, and judges no person. {result.model ? `Model: ${result.model}.` : ''}
      </p>
      <section className="card">
        <h2>Of the last {result.looked} pull requests, {result.strangersFound >= 50 ? 'at least 50' : result.strangersFound} came from people new to this project.</h2>
        <p>Those would have waited for a free vouch or a refundable hold, and the rest would have gone straight to review.{result.strangersFound > s.strangers ? ` This shows the latest ${s.strangers}.` : ''}</p>
        {s.open > 0 && s.oldestOpenDays !== null && (
          <p><strong>{s.open} of these {s.strangers} are still open,</strong> the oldest for {s.oldestOpenDays} days.</p>
        )}
        {s.merged > 0 && (
          <p><strong>{s.merged} of them were merged.</strong> They would have held {money(s.meanMergedCents)} on average, and {s.mergedAtMost} would have been asked for the maximum, all of it released at review.</p>
        )}
        {s.closed > 0 && (
          <p><strong>{s.closed} were closed without merging.</strong> They would have held {money(s.meanClosedCents)} on average, and {s.closedHigh} would have been asked for the maximum.</p>
        )}
        <p className="muted">Closed does not mean bad, and merged does not mean good. {result.rows.length < 5 ? 'This is too few pull requests to say much.' : 'This is a small recent sample, and the published evaluation is the larger test.'}</p>
      </section>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Pull request</th><th>Opened</th><th>What the maintainers did</th><th>AI band</th><th>Hold</th><th>Why, in the model&apos;s words</th></tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.number}>
                <td className="note"><a href={row.url}>#{row.number}</a> {row.title}</td>
                <td>{row.openedAt}</td>
                <td>{OUTCOME[row.outcome]}</td>
                <td>{row.band ? BAND[row.band] : 'No read'}</td>
                <td>{money(row.amountCents)}</td>
                <td className="note">{row.reason ?? 'The diff from when it opened could not be read.'}{row.flagged ? ' Flagged: has text aimed at AI reviewers.' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ marginTop: '1.25rem' }}><Link href="/replay">Replay another repository</Link></p>
    </>
  );
}
