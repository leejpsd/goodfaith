import { PAYOUT_AFTER_DAYS, toPayPalValue } from './hold';
import type { Triage } from './triage/triage';

// A maintainer filters on this to see only what has been through a door.
export const WAITING_LABEL = 'waiting for vouch or hold';

const readableDate = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' at ')} UTC`;

export function gateComment(input: { login: string; holdUrl: string; minCents: number; maxCents: number }): string {
  return [
    `Welcome, @${input.login}. This project reviews a first pull request after one of these two steps.`,
    '',
    `**1. Ask for a vouch. It is free.** Say what this change fixes and why, in a comment here. A maintainer can reply \`!vouch\`.`,
    '',
    `**2. Or place a refundable hold**, $${toPayPalValue(input.minCents)} to $${toPayPalValue(input.maxCents)}, through PayPal: ${input.holdUrl}`,
    `It is a hold and not a charge. Any good-faith review releases it, merged or not. Only a maintainer can forfeit it, and you can appeal first.`,
  ].join('\n');
}

export const vouchedComment = (login: string, by: string) =>
  `@${by} vouched for @${login}. This pull request is in the review queue, and no money was involved.`;

export const unvouchedComment = (login: string, by: string, found: boolean) =>
  found
    ? `@${by} removed the vouch for @${login}. Their next pull request goes through the gate, and this one stays where it is.`
    : `@${by}, @${login} has no vouch here to remove.`;

export const closedDoorComment = (login: string) =>
  `@${login} is on this project's denounced list, so this pull request will not enter review. A hold cannot change that. A maintainer can decide otherwise.`;

export const onlyMaintainersComment = (login: string) => `@${login}, only a maintainer can use that command.`;

const money = (cents: number) => `$${toPayPalValue(cents)}`;

export const heldComment = (login: string, cents: number) =>
  `@${login} placed a refundable ${money(cents)} PayPal hold. This pull request is in the review queue. Any good-faith review releases the hold, merged or not.`;

export const releasedComment = (login: string, cents: number, because: string) =>
  `@${login}, your ${money(cents)} hold is released in full, because ${because}.`;

export const forfeitComment = (input: { login: string; by: string; cents: number; reason: string; appealEndsAt: Date }) =>
  `@${input.by} moved to forfeit the ${money(input.cents)} hold and closed this pull request: ${input.reason}\n\nNo money has moved. @${input.login}, you can reply \`!appeal <reason>\` until ${readableDate(input.appealEndsAt)}. A maintainer can reply \`!release\` at any time.`;

export const appealComment = (login: string) =>
  `@${login} appealed. The hold stays in place and nothing can be captured until a maintainer answers with \`!release\` or \`!uphold\`. If nobody answers, the hold is released before PayPal would expire it.`;

export const upheldComment = (by: string) => `@${by} upheld the forfeit, so the hold is being captured.`;

export const capturedComment = (input: { login: string; cents: number; by: string | null }) =>
  `The ${money(input.cents)} hold from @${input.login} was captured${input.by ? `, following the forfeit by @${input.by}` : ''}. A maintainer can reverse this with \`!reverse <reason>\` for ${PAYOUT_AFTER_DAYS} day. After that it is paid out to the project, and a payout is final.`;

export const paidOutComment = (cents: number) => `The captured ${money(cents)} was paid out to the project through PayPal.`;

export const payoutFailedComment = (cents: number) => `PayPal could not pay out the captured ${money(cents)}. The money did not reach the project, and an operator needs to look at it.`;

export const captureFailedComment = (cents: number) =>
  `PayPal refused to capture the ${money(cents)} hold, so no money moved. The hold stays open until it is released.`;

export const refundedComment = (login: string, cents: number) => `@${login}, the ${money(cents)} capture was refunded in full.`;

export const changedOnPayPalComment = (state: string) => `PayPal reports this hold as ${state}. The change was made outside this app, and the ledger now shows it.`;

export const invalidCommandComment = (login: string, command: string, problem: 'missing_reason' | 'bad_target') =>
  `@${login}, \`!${command}\` ${problem === 'missing_reason' ? 'needs a reason after it' : 'takes one GitHub handle'}. Nothing changed.`;

const ISSUE: Record<Triage['addresses_issue'], string> = {
  yes: 'Addresses the linked issue.',
  partly: 'Partly addresses the linked issue.',
  no: 'Does not appear to address the linked issue.',
  no_linked_issue: 'No linked issue.',
};

export function reviewerBriefComment(triage: Triage, cents: number): string {
  return [
    `**Reviewer brief, written by AI (${triage.model}).** It suggests a hold size and cannot forfeit, vouch or close anything.`,
    '',
    triage.reviewer_brief,
    '',
    `- ${ISSUE[triage.addresses_issue]}`,
    `- Suggested hold: ${money(cents)}, the ${triage.band} band. ${triage.reasons.join(' ')}`,
    ...(triage.instructions_to_ai
      ? [`- **Flagged:** this pull request has text aimed at AI reviewers: "${triage.instructions_to_ai}". It cannot waive anything, because no model can waive a hold.`]
      : []),
  ].join('\n');
}

export const disputeOpenedComment = (cents: number) =>
  `A PayPal dispute was opened on this ${money(cents)} capture, so the payout to the project is stopped until PayPal decides. If it was already paid out, that payout stands, and the operator bears the result.`;

export const disputeResolvedComment = (outcome: string) => `PayPal resolved the dispute on this capture: ${outcome}.`;

export const noHoldComment = (login: string) => `@${login}, this pull request has no hold in a state that command can change.`;

export const refusedComment = (login: string, reason: string) => `@${login}, nothing changed: ${reason}.`;

export const CHECK = {
  known: { status: 'completed', conclusion: 'success', title: 'Known contributor', summary: 'This author goes straight to review.' },
  waiting: { status: 'in_progress', title: 'Waiting for a vouch or a hold', summary: 'See the comment on this pull request. A vouch is free.' },
  vouched: { status: 'completed', conclusion: 'success', title: 'Vouched by a maintainer', summary: 'No money was involved.' },
  closed: { status: 'completed', conclusion: 'failure', title: 'Author is denounced', summary: 'A hold cannot change this.' },
  held: { status: 'completed', conclusion: 'success', title: 'Refundable hold placed', summary: 'Any good-faith review releases it.' },
  released: { status: 'completed', conclusion: 'success', title: 'Hold released', summary: 'The contributor keeps all of it.' },
  forfeitPending: { status: 'completed', conclusion: 'neutral', title: 'Forfeit pending', summary: 'No money has moved. The contributor can appeal.' },
  captured: { status: 'completed', conclusion: 'neutral', title: 'Hold captured', summary: 'A maintainer can reverse this.' },
  refunded: { status: 'completed', conclusion: 'success', title: 'Capture refunded', summary: 'The contributor was repaid in full.' },
  paidOut: { status: 'completed', conclusion: 'neutral', title: 'Paid out to the project', summary: 'The forfeit is final.' },
} as const;
