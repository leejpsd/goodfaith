import { db } from '@/db/client';
import { githubFor } from '@/lib/github/client';
import { paypalClient } from '@/lib/paypal/client';
import type { HoldDeps } from './deps';

export const appUrl = () => process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000';

export const liveHoldDeps = (): HoldDeps => ({ db: db(), githubFor, paypal: paypalClient(), appUrl: appUrl() });
