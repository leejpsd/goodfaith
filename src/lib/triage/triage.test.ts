import { describe, expect, it } from 'vitest';
import { bandCents, linkedIssueNumber, readOutput, renderFacts, type OpenTimeFacts } from './triage';

const facts: OpenTimeFacts = {
  title: 'Fix',
  description: 'Fixes #12',
  files: [{ filename: 'a.js', additions: 1, deletions: 0, patch: 'x'.repeat(30_000) }, { filename: 'b.js', additions: 1, deletions: 0, patch: 'y' }],
  linkedIssue: null,
  accountAgeDays: 3,
  earlierPublicMerges: 0,
};

const response = (text: string) => ({ output: [{ content: [{ type: 'output_text', text }] }] });
const valid = { band: 'high', reasons: ['Diff does not match.'], addresses_issue: 'no', reviewer_brief: 'Check it.', instructions_to_ai: null };

describe('readOutput', () => {
  it('accepts valid output', () => {
    expect(readOutput(response(JSON.stringify(valid)))?.band).toBe('high');
  });

  it.each([
    ['not JSON', 'nope'],
    ['an unknown band', JSON.stringify({ ...valid, band: 'waived' })],
    ['a missing field', JSON.stringify({ band: 'low' })],
    ['no reasons', JSON.stringify({ ...valid, reasons: [] })],
  ])('rejects %s', (_name, text) => {
    expect(readOutput(response(text))).toBeNull();
  });

  it('rejects an empty response and a refusal', () => {
    expect(readOutput(null)).toBeNull();
    expect(readOutput({ output: [{ content: [{ type: 'refusal' }] }] })).toBeNull();
  });
});

describe('renderFacts', () => {
  it('caps the diff and says what it cut', () => {
    const rendered = JSON.parse(renderFacts(facts)) as { files: { patch: string; patch_truncated: boolean }[] };
    expect(rendered.files[0]!.patch).toHaveLength(24_000);
    expect(rendered.files[0]!.patch_truncated).toBe(true);
    expect(rendered.files[1]!.patch).toBe('');
    expect(rendered.files[1]!.patch_truncated).toBe(true);
  });
});

describe('linkedIssueNumber', () => {
  it.each([
    ['Fixes #12', 12],
    ['this closes #3 and more', 3],
    ['Resolved: #40', 40],
    ['See #12', null],
    ['', null],
  ])('reads %s', (text, expected) => {
    expect(linkedIssueNumber(text)).toBe(expected);
  });
});

describe('bandCents', () => {
  const bounds = { minCents: 200, maxCents: 2500, defaultCents: 500 };
  it('maps each band inside the bounds a maintainer chose', () => {
    expect(bandCents('low', bounds)).toBe(200);
    expect(bandCents('medium', bounds)).toBe(500);
    expect(bandCents('high', bounds)).toBe(2500);
  });
});
