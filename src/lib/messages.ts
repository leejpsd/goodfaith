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

export const CHECK = {
  known: { status: 'completed', conclusion: 'success', title: 'Known contributor', summary: 'This author goes straight to review.' },
  waiting: { status: 'in_progress', title: 'Waiting for a vouch or a hold', summary: 'See the comment on this pull request. A vouch is free.' },
  vouched: { status: 'completed', conclusion: 'success', title: 'Vouched by a maintainer', summary: 'No money was involved.' },
  closed: { status: 'completed', conclusion: 'failure', title: 'Author is denounced', summary: 'A hold cannot change this.' },
} as const;
