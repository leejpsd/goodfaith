import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { DoorDecision, AuthorAssociation } from '@/lib/gate';
import type { HoldState } from '@/lib/hold';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable(
  'projects',
  {
    id: id(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    // The bounds a maintainer chose. The model can only pick inside them.
    minCents: integer('min_cents').notNull().default(200),
    maxCents: integer('max_cents').notNull().default(2500),
    defaultCents: integer('default_cents').notNull().default(500),
    appealDays: integer('appeal_days').notNull().default(7),
    createdAt: createdAt(),
  },
  (t) => [unique('projects_owner_repo').on(t.owner, t.repo)],
);

export type PullRequestStatus = 'waiting' | 'in_review' | 'blocked' | 'merged' | 'closed';

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id),
    number: integer('number').notNull(),
    authorLogin: text('author_login').notNull(),
    authorAssociation: text('author_association').$type<AuthorAssociation>().notNull(),
    title: text('title').notNull(),
    htmlUrl: text('html_url').notNull(),
    door: text('door').$type<DoorDecision['door']>().notNull(),
    status: text('status').$type<PullRequestStatus>().notNull(),
    checkRunId: bigint('check_run_id', { mode: 'number' }),
    gateCommentId: bigint('gate_comment_id', { mode: 'number' }),
    triage: jsonb('triage'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('pull_requests_project_number').on(t.projectId, t.number)],
);

export const vouches = pgTable(
  'vouches',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id),
    // Lowercase, since GitHub handles ignore case.
    login: text('login').notNull(),
    vouchedBy: text('vouched_by').notNull(),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id),
    createdAt: createdAt(),
  },
  (t) => [unique('vouches_project_login').on(t.projectId, t.login)],
);

export type StoredHoldState = HoldState | 'awaiting_approval';

export const holds = pgTable('holds', {
  id: id(),
  // One hold per pull request. An abandoned approval reuses this row with a new order.
  pullRequestId: uuid('pull_request_id').notNull().unique().references(() => pullRequests.id),
  state: text('state').$type<StoredHoldState>().notNull(),
  cents: integer('cents').notNull(),
  orderId: text('order_id').notNull(),
  authorizationId: text('authorization_id'),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }),
  reauthorized: boolean('reauthorized').notNull().default(false),
  appealEndsAt: timestamp('appeal_ends_at', { withTimezone: true }),
  captureId: text('capture_id'),
  refundId: text('refund_id'),
  forfeitedBy: text('forfeited_by'),
  forfeitReason: text('forfeit_reason'),
  appealReason: text('appeal_reason'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerKind = 'vouched' | 'held' | 'voided' | 'forfeit_opened' | 'appealed' | 'captured' | 'paid_out' | 'refunded';

// The public record. Rows are only ever added, and a reconciliation fills in `reconciledAt`.
export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: id(),
    projectId: uuid('project_id').notNull().references(() => projects.id),
    pullRequestId: uuid('pull_request_id').notNull().references(() => pullRequests.id),
    holdId: uuid('hold_id').references(() => holds.id),
    kind: text('kind').$type<LedgerKind>().notNull(),
    cents: integer('cents').notNull().default(0),
    paypalId: text('paypal_id'),
    actor: text('actor'),
    note: text('note'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_events_created_at').on(t.createdAt)],
);

// A delivery seen twice does nothing the second time, because both senders retry.
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    source: text('source').$type<'github' | 'paypal'>().notNull(),
    deliveryId: text('delivery_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.deliveryId] })],
);
