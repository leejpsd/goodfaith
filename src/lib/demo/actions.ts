import type { PullRequestStatus, StoredHoldState } from '@/db/schema';
import type { Role } from './github';

// Everything a person can do on the try page, in the order the page offers it. The text is
// fixed here, so the page can never post anything else.
export const ACTIONS = {
  vouch: { role: 'maintainer', label: 'Comment !vouch', comment: '!vouch' },
  review: { role: 'maintainer', label: 'Submit a review', review: 'Reviewed in the demo. This counts as a good-faith review.' },
  forfeit: { role: 'maintainer', label: 'Comment !forfeit', comment: '!forfeit Testing the forfeit path from the try page.' },
  appeal: { role: 'contributor', label: 'Comment !appeal', comment: '!appeal Testing the appeal path from the try page.' },
  release: { role: 'maintainer', label: 'Comment !release', comment: '!release' },
  uphold: { role: 'maintainer', label: 'Comment !uphold', comment: '!uphold' },
  reverse: { role: 'maintainer', label: 'Comment !reverse', comment: '!reverse Testing the refund path from the try page.' },
} as const satisfies Record<string, { role: Role; label: string; comment?: string; review?: string }>;

export type TryAction = keyof typeof ACTIONS;

export function availableActions(status: PullRequestStatus, hold: StoredHoldState | null): TryAction[] {
  // A forfeit closes the pull request, and the appeal and what follows go on after that.
  switch (hold) {
    case 'held':
      return status === 'in_review' ? ['review', 'forfeit'] : [];
    case 'forfeit_pending':
      return ['appeal', 'release'];
    case 'appealed':
      return ['uphold', 'release'];
    case 'captured':
      return ['reverse'];
    case 'voided':
    case 'refunded':
    case 'paid_out':
      return [];
    default:
      return status === 'waiting' ? ['vouch'] : [];
  }
}
