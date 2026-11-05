# Triage evaluation rules

These rules are fixed before the first run of the model. The SHA-256 of this file was published in a public gist first, so GitHub's timestamp shows it was not changed afterwards. Any rerun or change is disclosed in `RESULTS.md`.

## The question

When a stranger opens a pull request, does the model's band (low, medium or high) separate low-effort pull requests from good ones, better than a plain rule using account age and earlier merges?

## Read-only

The collector only reads public GitHub data. It never comments on, labels or contacts any project in the set.

## The sets

All are pull requests created from 2025-06-01 to 2026-11-04, in repositories with at least 1,000 stars that are not forks or archived. Authors are users and not bots. Each set is drawn at random with a fixed seed (`goodfaith-2026-11-05`).

- **Low-effort set, 1,000 pull requests.** Closed and unmerged, carrying a maintainer's `ai slop`, `ai-slop`, `slop` or `spam` label, from an author whose association is not owner, member, collaborator or contributor. At most 50 per repository.
- **Not used as labels:** `ai generated` and `ai-generated`, because a project's own members often apply them to mark disclosure and not to judge quality.
- **Control set, up to 1,000 pull requests.** Merged, from an author with no earlier merged pull request in that repository and no owner, member or collaborator association, in the same repositories, with at most as many per repository as the low-effort set took from it.
- **Unclear set, up to 200 pull requests.** Closed, unmerged and unlabelled, from outsiders, at most 5 per repository. Reported separately, and it counts as neither a hit nor a miss.

Pull requests that can no longer be read, or whose author's account is gone, are dropped and counted.

## What the model sees

Only what was public when the pull request opened, through the same prompt and code as the product (`src/lib/triage/triage.ts`):

- Title and description. These can have been edited later, which GitHub does not let us undo. This is disclosed as a limit.
- The diff from the base to the last commit dated at or before the pull request was created. If no commit qualifies, for example after a force push, the pull request is dropped and counted.
- The linked issue, if the description names one with a closing keyword.
- The account's age when the pull request opened, and its public merged pull requests before then.

It never sees labels, comments, reviews, state, later commits, the repository's name, the author's name or `author_association`.

## Tuning and the held-out run

A pull request goes to the tuning set if the first byte of the SHA-256 of its URL is below 51, which is about 20%. The rest are held out.

- The prompt and the choice of model may change only by looking at the tuning set. `gpt-6.1-sol` and `gpt-6-luna` are both compared there. A switch happens before the held-out run, and the product then uses the model the figure describes.
- The held-out set is scored once. Any rerun is disclosed with both results.
- 100 held-out pull requests, drawn with the same seed, are run a second time to report how often the band repeats.

## The plain rule

"High if the account is younger than A days, or has at most M earlier public merges." A comes from 7, 30, 90 and 365, and M from 0, 1, 5 and 20. The best pair on the tuning set is then fixed for the held-out set.

## How it is scored

- **The table.** Counts of low-effort and control pull requests in each band, for the model, on the held-out set.
- **The main figure.** Balanced accuracy of "high" against everything else: the mean of the share of low-effort pull requests placed in high, and the share of control pull requests not placed in high.
- **Against the plain rule.** The difference in balanced accuracy, with a 95% interval from 1,000 paired bootstrap samples. The model beats the rule only if the whole interval is above zero. If it does not, that is published, and the model's job gets rethought before the video.
- **Misses.** A low-effort pull request placed in the low band, or a control pull request placed in the high band.

## What gets published

In this folder: these rules, the counts at each step, the table, the repeat-run agreement, the comparison with the plain rule, and every miss as a link with the model's reason. No usernames or avatars, because a miss should not read as an accusation against a person. Handles in the model's text are removed.

## Limits to state beside the figure

A label is one maintainer's view. Merged does not mean good. Titles and descriptions may have been edited after opening. A label like `spam` may be applied for reasons that are not about effort. A public figure from these sets says nothing about pull requests with no label at all.
