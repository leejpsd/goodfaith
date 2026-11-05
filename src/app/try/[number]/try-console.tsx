'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ACTIONS, type TryAction } from '@/lib/demo/actions';
import type { TryState } from '@/server/try-flow';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const ROLE = { maintainer: 'As the maintainer', contributor: 'As the stranger' } as const;

const EFFECT: Record<TryAction, string> = {
  vouch: 'Lets them in for free. No PayPal, no money, and a $0 row on the ledger.',
  review: 'Counts as a good-faith review, so PayPal voids the hold in full.',
  forfeit: 'Gives a public reason and opens the appeal window. No money moves.',
  appeal: 'Blocks any capture until a maintainer answers.',
  release: 'PayPal voids the hold in full.',
  uphold: 'Answers the appeal, and PayPal captures the hold.',
  reverse: 'PayPal refunds the capture in full. After a day it would be paid out and final.',
};

const LEDGER = { vouched: 'Vouched', held: 'Hold placed', voided: 'Hold released', forfeit_opened: 'Forfeit', appealed: 'Appealed', captured: 'Captured', paid_out: 'Paid out', refunded: 'Refunded', disputed: 'Dispute opened', dispute_resolved: 'Dispute resolved' } as const;

function headline(state: TryState): string {
  const hold = state.hold?.state;
  if (hold === 'held') return `The ${money(state.hold!.cents)} hold is in place, and the pull request is in the review queue.`;
  if (hold === 'forfeit_pending') return 'A maintainer moved to forfeit. No money has moved.';
  if (hold === 'appealed') return 'The stranger appealed. Nothing can be captured until a maintainer answers.';
  if (hold === 'captured') return `PayPal captured the ${money(state.hold!.cents)}.`;
  if (hold === 'voided') return `The ${money(state.hold!.cents)} hold was released in full.`;
  if (hold === 'refunded') return `The ${money(state.hold!.cents)} was refunded in full.`;
  if (hold === 'paid_out') return `The ${money(state.hold!.cents)} was paid out to the project.`;
  if (state.status === 'in_review') return 'A maintainer vouched. The pull request is in the review queue, and no money was involved.';
  return 'The pull request is waiting at the gate. There are two ways in.';
}

export function TryConsole({ number }: { number: string }) {
  const [state, setState] = useState<TryState | null>(null);
  const [missing, setMissing] = useState(0);
  const [sending, setSending] = useState<TryAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/try/${number}`, { cache: 'no-store' }).catch(() => null);
    if (response?.ok) {
      const next = (await response.json()) as TryState;
      setState(next);
      setMissing(0);
      setSending((current) => (current && next.actions.includes(current) ? current : null));
    } else {
      setMissing((n) => n + 1);
    }
  }, [number]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(action: TryAction) {
    setSending(action);
    setMessage(null);
    const response = await fetch(`/api/try/${number}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    if (!response.ok) {
      setSending(null);
      setMessage('GitHub did not accept that comment. Try again in a moment.');
    }
  }

  if (!state) {
    return missing > 8 ? (
      <p>This pull request is not part of the demo. <Link href="/try">Open a new one</Link>.</p>
    ) : (
      <p className="muted" role="status">Waiting for GitHub to tell the app about the pull request.</p>
    );
  }

  const waiting = state.status === 'waiting';
  const done = state.actions.length === 0 && !waiting;

  return (
    <>
      <h1>{state.title}</h1>
      <p className="muted"><a href={state.url}>Pull request #{state.number} on GitHub</a>, opened by a test account. Keep it open beside this page to watch the comments arrive.</p>

      <section className="card" aria-live="polite">
        <h2>{headline(state)}</h2>
        {state.triage ? (
          <>
            <p>The AI suggested the {state.triage.band} band, which is {money(state.hold?.cents ?? (state.triage.band === 'low' ? 200 : state.triage.band === 'high' ? 2500 : 500))} here. {state.triage.reasons.join(' ')}</p>
            {state.triage.instructions_to_ai && (
              <p className="warn">Flagged: &quot;{state.triage.instructions_to_ai}&quot; It cannot waive anything, because no model can waive a hold.</p>
            )}
          </>
        ) : (
          waiting && <p className="muted" role="status">The AI is reading the pull request.</p>
        )}
      </section>

      {(waiting || state.actions.length > 0) && (
        <section className="card">
          <h2>What you can do now</h2>
          <ul className="choices">
            {state.actions.map((action) => {
              const step = ACTIONS[action];
              return (
                <li key={action}>
                  <button className="button" type="button" disabled={sending !== null} onClick={() => void act(action)}>{step.label}</button>
                  <p><strong>{ROLE[step.role]}.</strong> {EFFECT[action]}</p>
                </li>
              );
            })}
            {waiting && (
              <li>
                <a className="button primary" href={`/hold/${state.id}`}>Place the hold</a>
                <p><strong>As the stranger.</strong> Approve a refundable hold with the PayPal sandbox buyer login, then come back to this page.</p>
              </li>
            )}
          </ul>
          {sending && <p className="muted" role="status">Posted to GitHub. Waiting for the app to act on it.</p>}
          {message && <p className="warn" role="alert">{message}</p>}
        </section>
      )}

      {done && (
        <p><Link className="button primary" href="/try">Try another pull request</Link></p>
      )}

      {state.events.length > 0 && (
        <section className="card">
          <h2>On the public ledger</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Event</th><th>Amount</th><th>PayPal ID</th><th>PayPal webhook</th></tr>
              </thead>
              <tbody>
                {state.events.map((event) => (
                  <tr key={event.id}>
                    <td>{LEDGER[event.kind]}</td>
                    <td>{money(event.cents)}</td>
                    <td className="id">{event.paypalId ?? 'none'}</td>
                    <td>{event.kind === 'vouched' || event.kind === 'forfeit_opened' || event.kind === 'appealed' ? 'none' : event.confirmed ? 'confirmed' : 'not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
