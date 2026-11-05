import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '@/db/schema';
import type { GitHub } from '@/lib/github/client';
import type { PayPal } from '@/lib/paypal/client';

export interface Deps {
  db: PgDatabase<PgQueryResultHKT, typeof schema>;
  github: GitHub;
  paypal: PayPal;
  appUrl: string;
}

// Paths that are not started by one GitHub delivery reach whichever installation owns the hold.
export type HoldDeps = Omit<Deps, 'github'> & { githubFor(installationId: number): GitHub };
