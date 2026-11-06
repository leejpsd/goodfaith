import { bandCents, type OpenTimeFacts, type TriageOutput } from '@/lib/triage/triage';

// A read-only look at what Goodfaith would have done on a public repository. It never writes to
// GitHub, contacts nobody, and stores no usernames.
export const REPLAY_SIZE = 20;
// A maintainer's bounds do not exist here, since no one installed anything, so it uses the defaults.
export const REPLAY_BOUNDS = { minCents: 200, maxCents: 2500, defaultCents: 500 };

export interface ListedPull {
  number: number;
  title: string;
  url: string;
  author: string;
  authorType: string;
  association: string;
  createdAt: string;
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface ReplayRow {
  number: number;
  title: string;
  url: string;
  openedAt: string;
  outcome: 'merged' | 'closed' | 'open';
  band: TriageOutput['band'] | null;
  amountCents: number | null;
  reason: string | null;
  brief: string | null;
  flagged: boolean;
  // Closed unmerged within an hour of opening, which on a project that gates strangers means
  // before anyone reviewed it.
  closedFast?: boolean;
  // Whether the same author had a pull request merged here afterwards. Only asked on a closed door.
  laterMerged?: boolean | null;
}

export interface ReplayResult {
  repo: string;
  at: string;
  model: string | null;
  looked: number;
  // How many of those came from people new to the project. `rows` shows the latest of them.
  strangersFound: number;
  // A project that closes most strangers' pull requests at once gets a replay of those, since
  // they are the people a second door is for.
  mode?: 'closed_door' | 'recent';
  rows: ReplayRow[];
}

export const CLOSED_FAST_MS = 3_600_000;
// Fewer than this many fast closes in the recent pull requests is ordinary housekeeping, not a door.
export const CLOSED_DOOR_MIN = 5;

export const closedFast = (pull: Pick<ListedPull, 'mergedAt' | 'closedAt' | 'createdAt'>) =>
  !pull.mergedAt && pull.closedAt !== null && Date.parse(pull.closedAt) - Date.parse(pull.createdAt) < CLOSED_FAST_MS;

const INSIDE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const isBot = (pull: Pick<ListedPull, 'author' | 'authorType'>) => pull.authorType === 'Bot' || pull.author.endsWith('[bot]');

// Strangers are worked out in two steps, because `author_association` reflects today and not the
// day the pull request opened: a first-timer whose work merged now reads as a contributor.
export function outsideAuthors(pulls: ListedPull[]): ListedPull[] {
  return pulls.filter((pull) => !isBot(pull) && !INSIDE.has(pull.association));
}

export function outcomeOf(pull: Pick<ListedPull, 'state' | 'mergedAt'>): ReplayRow['outcome'] {
  if (pull.mergedAt) return 'merged';
  return pull.state === 'closed' ? 'closed' : 'open';
}

export function toRow(pull: ListedPull, triage: TriageOutput | null, laterMerged: boolean | null = null): ReplayRow {
  return {
    closedFast: closedFast(pull),
    laterMerged,
    number: pull.number,
    title: stripHandles(pull.title),
    url: pull.url,
    openedAt: pull.createdAt.slice(0, 10),
    outcome: outcomeOf(pull),
    band: triage?.band ?? null,
    amountCents: triage ? bandCents(triage.band, REPLAY_BOUNDS) : null,
    // The model's words can quote a handle from the pull request, and this page shows none.
    reason: triage ? stripHandles(triage.reasons.join(' ')) : null,
    brief: triage ? stripHandles(triage.reviewer_brief) : null,
    flagged: Boolean(triage?.instructions_to_ai),
  };
}

export function stripHandles(text: string): string {
  return text.replace(/(^|[^\w/])@[a-z\d](?:[a-z\d-]{0,38})/gi, '$1a user');
}

const REPO = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d._-]{1,100}$/i;

export function readRepo(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return REPO.test(trimmed) ? trimmed.toLowerCase() : null;
}

export interface ReplaySummary {
  strangers: number;
  open: number;
  oldestOpenDays: number | null;
  merged: number;
  mergedAtMost: number;
  closed: number;
  closedHigh: number;
  meanMergedCents: number | null;
  meanClosedCents: number | null;
  closedFast: number;
  closedFastLow: number;
  closedFastLaterMerged: number;
}

const mean = (values: number[]) => (values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null);

export function summarize(rows: ReplayRow[], now = new Date()): ReplaySummary {
  const open = rows.filter((row) => row.outcome === 'open');
  const days = open.map((row) => Math.floor((now.getTime() - Date.parse(row.openedAt)) / 864e5));
  const sized = rows.filter((row) => row.amountCents !== null);
  const merged = sized.filter((row) => row.outcome === 'merged');
  const closed = sized.filter((row) => row.outcome === 'closed');
  return {
    strangers: rows.length,
    open: open.length,
    oldestOpenDays: days.length ? Math.max(...days) : null,
    merged: merged.length,
    mergedAtMost: merged.filter((row) => row.band === 'high').length,
    closed: closed.length,
    closedHigh: closed.filter((row) => row.band === 'high').length,
    meanMergedCents: mean(merged.map((row) => row.amountCents!)),
    meanClosedCents: mean(closed.map((row) => row.amountCents!)),
    closedFast: rows.filter((row) => row.closedFast).length,
    closedFastLow: rows.filter((row) => row.closedFast && row.band === 'low').length,
    closedFastLaterMerged: rows.filter((row) => row.closedFast && row.laterMerged).length,
  };
}

export type { OpenTimeFacts };
