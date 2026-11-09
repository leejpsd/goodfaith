import evidence from './evidence.json';

// The evaluation's words for people, not its file's codes.
const GROUP: Record<string, string> = { low_effort: 'Labelled low effort', control: 'Merged first-timer', unclear: 'Unclear' };
const BAND: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const RULE: Record<string, string> = { high: 'High', not_high: 'Not high' };

export interface EvidenceRow {
  // Studio's flat query merges identical rows, and most rows here carry no link to tell them apart.
  id: number;
  repo: string;
  group: string;
  label: string;
  band: string;
  rule: string;
  miss: number;
  url: string;
  reason: string;
}

export const EVIDENCE_ROWS: EvidenceRow[] = evidence.evaluation.map((r, id) => ({
  id,
  repo: r.repo,
  group: GROUP[r.set] ?? r.set,
  label: r.label === 'none' ? 'No label' : r.label,
  band: BAND[r.band] ?? r.band,
  rule: RULE[r.rule] ?? r.rule,
  miss: r.miss,
  url: r.url,
  reason: r.reason,
}));

export const EVIDENCE_SCORES = [{ ...evidence.scores, model: evidence.scores.model / 100, rule: evidence.scores.rule / 100 }];
export const EVIDENCE_LABELS = evidence.labels;
// Lowest band first, which is the order the chart draws them in.
const BAND_ORDER = ['Low', 'Medium', 'High'];
export const CLOSED_DOORS = evidence.doors.map((r) => ({ band: BAND[r.band] ?? r.band, laterMerged: r.laterMerged })).sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));

export const MISS_FIELDS = ['id', 'repo', 'group', 'label', 'band', 'rule', 'miss', 'url', 'reason'] as const;
export type Reader = 'model' | 'rule';

const GROUPS = ['Labelled low effort', 'Merged first-timer', 'Unclear'];
export const columnsOf = (reader: Reader) => (reader === 'model' ? ['Low', 'Medium', 'High'] : ['Not high', 'High']);

// The two mistakes that matter: a low-effort pull request sized too small, and a good newcomer
// charged the most. The rule has only two outcomes, so not flagging low effort is its miss.
export function isMissCell(group: string, column: string, reader: Reader): boolean {
  if (group === 'Merged first-timer') return column === 'High';
  return group === 'Labelled low effort' && column === (reader === 'model' ? 'Low' : 'Not high');
}

export interface Cell {
  column: string;
  count: number;
  share: number;
  miss: boolean;
}

export function tally(rows: Pick<EvidenceRow, 'group' | 'band' | 'rule'>[], reader: Reader) {
  return GROUPS.map((group) => {
    const inGroup = rows.filter((r) => r.group === group);
    const cells: Cell[] = columnsOf(reader).map((column) => {
      const count = inGroup.filter((r) => (reader === 'model' ? r.band : r.rule) === column).length;
      return { column, count, share: inGroup.length ? count / inGroup.length : 0, miss: isMissCell(group, column, reader) };
    });
    return { group, total: inGroup.length, cells };
  });
}
