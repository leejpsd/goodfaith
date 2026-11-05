import { describe, expect, it } from 'vitest';
import { outcomeOf, outsideAuthors, readRepo, stripHandles, summarize, toRow, type ListedPull, type ReplayRow } from './replay';

const pull = (over: Partial<ListedPull> = {}): ListedPull => ({
  number: 1,
  title: 'Fix',
  url: 'https://github.com/o/r/pull/1',
  author: 'someone',
  authorType: 'User',
  association: 'NONE',
  createdAt: '2026-10-01T00:00:00Z',
  state: 'closed',
  mergedAt: null,
  ...over,
});

const triage = { band: 'high' as const, reasons: ['Thanks @someone, this reads generic.'], addresses_issue: 'no' as const, reviewer_brief: 'Ask @other first.', instructions_to_ai: null };

describe('readRepo', () => {
  it.each([
    ['paypal/agent-toolkit', 'paypal/agent-toolkit'],
    ['https://github.com/PayPal/Agent-Toolkit/', 'paypal/agent-toolkit'],
    ['  scrapy/scrapy.git ', 'scrapy/scrapy'],
  ])('reads %s', (input, expected) => {
    expect(readRepo(input)).toBe(expected);
  });

  it.each(['', 'paypal', 'a/b/c', '../etc/passwd', 'o/r?x=1', 'o/r#1'])('refuses %s', (input) => {
    expect(readRepo(input)).toBeNull();
  });
});

describe('outsideAuthors', () => {
  it('leaves out bots and people inside the project', () => {
    const kept = outsideAuthors([pull(), pull({ association: 'MEMBER' }), pull({ association: 'OWNER' }), pull({ association: 'COLLABORATOR' }), pull({ authorType: 'Bot' }), pull({ author: 'dependabot[bot]' }), pull({ association: 'CONTRIBUTOR' })]);
    expect(kept.map((p) => p.association)).toEqual(['NONE', 'CONTRIBUTOR']);
  });
});

describe('outcomeOf', () => {
  it('reads the public outcome', () => {
    expect(outcomeOf({ state: 'closed', mergedAt: '2026-10-02T00:00:00Z' })).toBe('merged');
    expect(outcomeOf({ state: 'closed', mergedAt: null })).toBe('closed');
    expect(outcomeOf({ state: 'open', mergedAt: null })).toBe('open');
  });
});

describe('stripHandles', () => {
  it('removes handles and leaves email-like text and paths', () => {
    expect(stripHandles('Thanks @some-one and (@other).')).toBe('Thanks a user and (a user).');
    expect(stripHandles('see a@b.com and /path/@scope')).toBe('see a@b.com and /path/@scope');
  });
});

describe('toRow', () => {
  it('maps the band to an amount and strips handles', () => {
    const row = toRow(pull(), triage);
    expect(row).toMatchObject({ band: 'high', amountCents: 2500, outcome: 'closed', flagged: false, openedAt: '2026-10-01' });
    expect(row.reason).not.toContain('@someone');
    expect(row.brief).not.toContain('@other');
    expect(JSON.stringify(row)).not.toContain('someone');
  });

  it('says when the model did not answer', () => {
    expect(toRow(pull(), null)).toMatchObject({ band: null, amountCents: null, reason: null });
  });
});

describe('summarize', () => {
  const row = (outcome: ReplayRow['outcome'], band: ReplayRow['band'], amountCents: number | null): ReplayRow => ({ number: 1, title: '', url: '', openedAt: '', outcome, band, amountCents, reason: null, brief: null, flagged: false });

  it('compares what merged and closed pull requests would have held', () => {
    const s = summarize([row('merged', 'low', 200), row('merged', 'high', 2500), row('closed', 'high', 2500), row('closed', 'medium', 500), row('open', 'low', 200), row('closed', null, null)]);
    expect(s).toEqual({ strangers: 6, merged: 2, mergedAtMost: 1, closed: 2, closedHigh: 1, meanMergedCents: 1350, meanClosedCents: 1500 });
  });

  it('copes with nothing to average', () => {
    expect(summarize([]).meanMergedCents).toBeNull();
  });
});
