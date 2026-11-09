import { describe, expect, it } from 'vitest';
import { EVIDENCE_ROWS, EVIDENCE_SCORES, tally } from './misses';

const counts = (reader: 'model' | 'rule') => Object.fromEntries(tally(EVIDENCE_ROWS, reader).map((row) => [row.group, row.cells.map((c) => c.count)]));

describe('the evidence page', () => {
  it('matches the table in the published results', () => {
    expect(counts('model')).toEqual({ 'Labelled low effort': [189, 174, 389], 'Merged first-timer': [311, 77, 31], Unclear: [43, 49, 53] });
    expect(EVIDENCE_SCORES[0]).toMatchObject({ model: 0.722, rule: 0.648 });
  });

  it('counts what the plain rule did to merged first-timers', () => {
    expect(counts('rule')['Merged first-timer']).toEqual([292, 127]);
  });

  it('marks the two kinds of miss and nothing else', () => {
    const marked = tally(EVIDENCE_ROWS, 'model').flatMap((row) => row.cells.filter((c) => c.miss).map((c) => `${row.group}: ${c.column}`));
    expect(marked).toEqual(['Labelled low effort: Low', 'Merged first-timer: High']);
  });

  it('keeps every row distinct, since Studio merges identical ones', () => {
    expect(new Set(EVIDENCE_ROWS.map((r) => r.id)).size).toBe(1316);
  });

  it('links only the misses that are already published', () => {
    expect(EVIDENCE_ROWS.filter((r) => r.miss === 1)).toHaveLength(220);
    expect(EVIDENCE_ROWS.filter((r) => r.url).length).toBe(220);
    expect(JSON.stringify(EVIDENCE_ROWS)).not.toMatch(/"author"/);
  });
});
