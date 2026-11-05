import { toPayPalValue } from './hold';

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

export const closedDoorComment = (login: string) =>
  `@${login} is on this project's denounced list, so this pull request will not enter review. A hold cannot change that. A maintainer can decide otherwise.`;

export const onlyMaintainersComment = (login: string) => `@${login}, only a maintainer can use that command.`;

const money = (cents: number) => `$${toPayPalValue(cents)}`;

export const heldComment = (login: string, cents: number) =>
  `@${login} placed a refundable ${money(cents)} PayPal hold. This pull request is in the review queue. Any good-faith review releases the hold, merged or not.`;

export const releasedComment = (login: string, cents: number, because: string) =>
  `@${login}, your ${money(cents)} hold is released in full, because ${because}.`;

export const forfeitComment = (input: { login: string; by: string; cents: number; reason: string; appealEndsAt: Date }) =>
  `@${input.by} moved to forfeit the ${money(input.cents)} hold: ${input.reason}\n\nNo money has moved. @${input.login}, you can reply \`!appeal <reason>\` until ${input.appealEndsAt.toISOString()}. A maintainer can reply \`!release\` at any time.`;

export const appealComment = (login: string) =>
  `@${login} appealed. The hold stays in place and nothing can be captured until a maintainer answers with \`!release\` or \`!uphold\`. If nobody answers, the hold is released before PayPal would expire it.`;

export const upheldComment = (by: string) => `@${by} upheld the forfeit, so the hold is being captured.`;

export const capturedComment = (input: { login: string; cents: number; by: string | null }) =>
  `The ${money(input.cents)} hold from @${input.login} was captured${input.by ? `, following the forfeit by @${input.by}` : ''}. A maintainer can still reverse this with \`!reverse <reason>\`.`;

export const captureFailedComment = (cents: number) =>
  `PayPal refused to capture the ${money(cents)} hold, so no money moved. The hold stays open until it is released.`;

export const refundedComment = (login: string, cents: number) => `@${login}, the ${money(cents)} capture was refunded in full.`;

export const changedOnPayPalComment = (state: string) => `PayPal reports this hold as ${state}. The change was made outside this app, and the ledger now shows it.`;

export const invalidCommandComment = (login: string, command: string, problem: 'missing_reason' | 'bad_target') =>
  `@${login}, \`!${command}\` ${problem === 'missing_reason' ? 'needs a reason after it' : 'takes one GitHub handle'}. Nothing changed.`;

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
} as const;
