import { and, asc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import { ledgerEvents, projects, pullRequests } from '@/db/schema';
import { DEMO } from '@/lib/demo/constants';
import { LEDGER_LABEL, ledgerAmount } from '@/lib/ledger-labels';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'For judges' };


const CASES = [
  { number: 1, title: 'A newcomer gets in free', lookFor: 'a maintainer\u2019s !vouch, the check turning green, and a $0.00 row. PayPal never appears.' },
  { number: 3, title: 'A careful stranger gets every cent back', lookFor: 'a $2.00 hold, then a review, then the same authorization released. Nothing was captured, and PayPal\u2019s signed webhook confirmed it.' },
  { number: 2, title: 'A maintainer takes a hold, then gives it back', lookFor: 'the reason in !forfeit, an appeal that stops the clock, a capture only after !uphold, and a refund. The description also tells AI reviewers to waive the deposit, and the brief flags it.' },
  { number: 4, title: 'Nobody appeals', lookFor: 'a forfeit with a public reason. The capture waits out the appeal window. A day later the payout goes to a test account standing in for a foundation, not to the maintainer.' },
  { number: 5, title: 'A hold left waiting', lookFor: 'a hold nobody has acted on. Timeouts never forfeit, so after 28 days it is released in full.' },
];

const DOORS = [
  { href: '/replay/ghostty-org/ghostty', label: 'Replay a project that closes its door', lookFor: 'Ghostty closes newcomers\u2019 pull requests within the hour unless someone vouched. The replay shows what each would have held instead. It is read-only, and you can replay any public repository.' },
  { href: '/console', label: 'Open the maintainer console', lookFor: 'the refusal when you ask the assistant to capture a hold. It has no tool that can. Then ask it for a chart.' },
  { href: 'https://github.com/leejpsd/goodfaith/tree/master/evals/triage', label: 'Read the evaluation', lookFor: 'rules hashed and published before the run, a plain rule to beat, and every miss.' },
];

export default async function JudgesPage() {
  const rows = await db()
    .select({ event: ledgerEvents, pr: pullRequests })
    .from(ledgerEvents)
    .innerJoin(pullRequests, eq(ledgerEvents.pullRequestId, pullRequests.id))
    .innerJoin(projects, eq(pullRequests.projectId, projects.id))
    .where(and(eq(projects.owner, DEMO.owner), eq(projects.repo, DEMO.repo), inArray(pullRequests.number, CASES.map((c) => c.number))))
    .orderBy(asc(ledgerEvents.createdAt));

  return (
    <main className="page wide">
      <h1>For judges</h1>
      <p className="lede">Nothing to install, no login and no API key. These cases already happened on the PayPal sandbox, and the rows below come live from the ledger.</p>

      <section className="band">
        <h2>Five finished cases</h2>
        <div className="cases">
          {CASES.map((c) => {
            const events = rows.filter((r) => r.pr.number === c.number);
            return (
              <article key={c.number}>
                <h3>{c.title}</h3>
                <p><strong>Look for</strong> {c.lookFor}</p>
                {events.length > 0 && (
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr><th>When</th><th>Event</th><th>Amount</th><th>PayPal ID</th></tr>
                      </thead>
                      <tbody>
                        {events.map(({ event }) => (
                          <tr key={event.id}>
                            <td>{event.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
                            <td>{LEDGER_LABEL[event.kind]}</td>
                            <td>{ledgerAmount(event.kind, event.cents)}</td>
                            <td className="id">{event.paypalId ?? 'none'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p><a href={`https://github.com/${DEMO.owner}/${DEMO.repo}/pull/${c.number}`}>Open pull request #{c.number}</a></p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="band">
        <h2>Do it yourself in three minutes</h2>
        <div className="narrow">
          <p><Link href="/try">Open a pull request from a test account</Link> and play both sides. The free door needs nothing. The hold needs the sandbox buyer login from the testing instructions, because PayPal asks a person to approve it.</p>
          <p><strong>Look for</strong> the comments arriving on the real pull request, and the row on the <Link href="/ledger">public ledger</Link> at the end. To see a failure handled, tick the decline box before you approve: nothing is held, and the page offers another try.</p>
        </div>
      </section>

      <section className="band">
        <h2>Check our claims</h2>
        <div className="doors">
          {DOORS.map((d) => (
            <div key={d.href}>
              <h3>{d.href.startsWith('/') ? <Link href={d.href}>{d.label}</Link> : <a href={d.href}>{d.label}</a>}</h3>
              <p><strong>Look for</strong> {d.lookFor}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="band">
        <h2>What is real, and what is not</h2>
        <div className="narrow">
          <p><strong>Real:</strong> every PayPal sandbox call and ID, PayPal&apos;s signed webhooks, the GitHub App on a real repository, the OpenAI calls, and the public pull requests in the evaluation and the replay.</p>
          <p><strong>Simulated:</strong> the money is sandbox money. The contributors and maintainers in the demo are test accounts. The decline is PayPal&apos;s own negative testing.</p>
          <p><strong>Not shown:</strong> no outside project or contributor has used this. We found no measurement of whether a hold shrinks the flood, for this project or any other refundable bond.</p>
        </div>
      </section>
    </main>
  );
}
