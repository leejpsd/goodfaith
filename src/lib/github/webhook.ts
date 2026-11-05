import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthorAssociation } from '@/lib/gate';

export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const repo = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const installation = z.object({ id: z.number() });
const user = z.object({ login: z.string(), type: z.string() });

export const pullRequestEvent = z.object({
  action: z.string(),
  installation,
  repository: repo,
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    merged: z.boolean().nullish(),
    head: z.object({ sha: z.string() }),
    author_association: z.string().transform((v) => v as AuthorAssociation),
    user,
  }),
});
export type PullRequestEvent = z.infer<typeof pullRequestEvent>;

export const issueCommentEvent = z.object({
  action: z.string(),
  installation,
  repository: repo,
  issue: z.object({ number: z.number(), pull_request: z.object({}).loose().optional() }),
  comment: z.object({ body: z.string().nullable(), user }),
});
export type IssueCommentEvent = z.infer<typeof issueCommentEvent>;
