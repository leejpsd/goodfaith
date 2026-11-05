import { z } from 'zod';

// A maintainer sets the bounds in the repo, through the same review as any other change, and
// anyone can read them. Malformed settings are ignored, so a typo cannot widen the bounds.
const MAX_ALLOWED_CENTS = 10_000;

const settings = z
  .object({
    min_cents: z.number().int().min(100),
    max_cents: z.number().int().max(MAX_ALLOWED_CENTS),
    default_cents: z.number().int(),
    appeal_days: z.number().int().min(1).max(14),
    payout_receiver: z.email().nullable(),
  })
  .partial()
  .strict();

export interface ProjectSettings {
  minCents: number;
  maxCents: number;
  defaultCents: number;
  appealDays: number;
  payoutReceiver: string | null;
}

export function readSettings(text: string | null, current: ProjectSettings): ProjectSettings {
  if (!text) return current;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return current;
  }
  const parsed = settings.safeParse(json);
  if (!parsed.success) return current;
  const { min_cents, max_cents, default_cents, appeal_days, payout_receiver } = parsed.data;
  const next: ProjectSettings = {
    minCents: min_cents ?? current.minCents,
    maxCents: max_cents ?? current.maxCents,
    defaultCents: default_cents ?? current.defaultCents,
    appealDays: appeal_days ?? current.appealDays,
    payoutReceiver: payout_receiver === undefined ? current.payoutReceiver : payout_receiver,
  };
  return next.minCents <= next.defaultCents && next.defaultCents <= next.maxCents ? next : current;
}
