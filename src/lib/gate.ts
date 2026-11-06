import type { ListStatus } from './vouch';

// GitHub's values for a pull request author's relationship to the repo.
export type AuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'MANNEQUIN'
  | 'NONE';

export type DoorDecision =
  | { door: 'known'; reason: 'bot' | 'trusted_association' | 'on_vouch_list' | 'earned' }
  | { door: 'closed'; reason: 'denounced' }
  | { door: 'choose'; reason: 'newcomer' };

const TRUSTED: ReadonlySet<AuthorAssociation> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);

// Decides which door a pull request author faces. The model has no input here:
// it can change the size of a hold, never who gets in.
export function chooseDoor(input: {
  isBot: boolean;
  association: AuthorAssociation;
  listStatus: ListStatus;
  // A pull request of theirs went through Goodfaith's gate at another project and was merged.
  earned?: boolean;
}): DoorDecision {
  if (input.isBot) return { door: 'known', reason: 'bot' };
  if (TRUSTED.has(input.association)) return { door: 'known', reason: 'trusted_association' };
  // Money does not buy back a ban, so a denounced user is not offered a hold.
  if (input.listStatus === 'denounced') return { door: 'closed', reason: 'denounced' };
  if (input.listStatus === 'vouched') return { door: 'known', reason: 'on_vouch_list' };
  // A merge is a maintainer's judgement that the work was good, so it carries to the next project.
  if (input.earned) return { door: 'known', reason: 'earned' };
  return { door: 'choose', reason: 'newcomer' };
}
