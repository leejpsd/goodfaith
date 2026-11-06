import { z } from 'zod';

// A maintainer sets the bounds in the repo, through the same review as any other change, and
// anyone can read them. Malformed settings are ignored, so a typo cannot widen the bounds.
export const MIN_ALLOWED_CENTS = 100;
export const MAX_ALLOWED_CENTS = 10_000;

const settings = z
  .object({
    min_cents: z.number().int().min(MIN_ALLOWED_CENTS),
    max_cents: z.number().int().max(MAX_ALLOWED_CENTS),
    default_cents: z.number().int(),
    appeal_days: z.number().int().min(1).max(14),
    payout_receiver: z.email().nullable(),
    trust_earned_elsewhere: z.boolean(),
  })
  .partial()
  .strict();

export interface ProjectSettings {
  minCents: number;
  maxCents: number;
  defaultCents: number;
  appealDays: number;
  payoutReceiver: string | null;
  // Whether a newcomer whose gated pull request was merged at another project skips the gate here.
  trustEarned: boolean;
}

// What a project gets before it writes a settings file, matching the database defaults.
export const DEFAULT_SETTINGS: ProjectSettings = { minCents: 200, maxCents: 2500, defaultCents: 500, appealDays: 7, payoutReceiver: null, trustEarned: true };

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// The same reading as the gate's, with the reasons a file would be ignored, so a maintainer
// can see why before a stranger's pull request does.
export function checkSettings(text: string, current: ProjectSettings = DEFAULT_SETTINGS): { settings: ProjectSettings; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { settings: current, problems: ['The file is not valid JSON.'] };
  }
  const parsed = settings.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      if (issue.code === 'unrecognized_keys') return `Unknown setting: ${issue.keys.join(', ')}.`;
      const key = issue.path.join('.');
      if (key === 'min_cents') return `min_cents must be a whole number of cents, at least ${MIN_ALLOWED_CENTS}.`;
      if (key === 'max_cents') return `max_cents must be a whole number of cents, at most ${MAX_ALLOWED_CENTS}.`;
      if (key === 'default_cents') return 'default_cents must be a whole number of cents.';
      if (key === 'appeal_days') return 'appeal_days must be a whole number from 1 to 14.';
      if (key === 'payout_receiver') return 'payout_receiver must be an email address, or null.';
      if (key === 'trust_earned_elsewhere') return 'trust_earned_elsewhere must be true or false.';
      return issue.path.length ? `${key}: ${issue.message}` : 'The file must be one JSON object.';
    });
    return { settings: current, problems };
  }
  const { min_cents, max_cents, default_cents, appeal_days, payout_receiver, trust_earned_elsewhere } = parsed.data;
  const next: ProjectSettings = {
    minCents: min_cents ?? current.minCents,
    maxCents: max_cents ?? current.maxCents,
    defaultCents: default_cents ?? current.defaultCents,
    appealDays: appeal_days ?? current.appealDays,
    payoutReceiver: payout_receiver === undefined ? current.payoutReceiver : payout_receiver,
    trustEarned: trust_earned_elsewhere ?? current.trustEarned,
  };
  if (next.minCents <= next.defaultCents && next.defaultCents <= next.maxCents) return { settings: next, problems: [] };
  return { settings: current, problems: [`The amounts must run minimum, default, maximum: ${usd(next.minCents)} to ${usd(next.defaultCents)} to ${usd(next.maxCents)} does not.`] };
}

export function readSettings(text: string | null, current: ProjectSettings): ProjectSettings {
  return text ? checkSettings(text, current).settings : current;
}
