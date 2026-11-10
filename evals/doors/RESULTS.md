# Closed doors

Who closes a newcomer's pull request within an hour of opening, and what a refundable hold would have been instead. Read-only, collected on 2026-11-06.

## What we looked at

The 260 repositories with 1,000 or more stars from the [triage evaluation](../triage/RULES.md), and the latest 100 pull requests in each, so the window differs by project and mostly covers October and early November 2026. A newcomer is an author who is not an owner, member or collaborator and is not a bot, as GitHub reports it today. A pull request counts as closed fast when it was closed unmerged within an hour, and the closer is the account GitHub records as having closed it.

## Who closed them

| | Pull requests |
|---|---|
| From newcomers | 14,516 |
| Closed unmerged within an hour | 1,487 |
| ... by the author | 662 |
| ... by a person in the project | 514 |
| ... **by a bot** | **307** |
| ... closer not recorded | 4 |

Of the 307 authors closed by a bot, GitHub reports 282 with nothing merged in that project (`NONE`) and 25 as earlier contributors (`CONTRIBUTOR`), one of them with many merges there. So "newcomer" here means outside the project, not always a first-timer.

Bots closed newcomers' pull requests at 23 projects, and at 13 of them five or more times. Reading one bot message at each of those, the reasons were spam or slop detection (juice-shop, scrapy, RSSHub), a no-AI policy (yt-dlp), an application to contribute (postiz), process rules such as being assigned to the issue first (Nettacker, mastg, scikit-learn, uptime-kuma), and a submission checklist (flathub). Some of these are exactly right for those projects. One reply on such a pull request said a spam workflow had closed "a legitimate performance optimization".

## What a hold would have been

We ran the product's own prompt and model (`gpt-6-luna`) on 304 of the 307 bot-closed pull requests, reading only what was public when each opened. 3 could not be read. At the demo repository's amounts:

| Band | Hold | Pull requests |
|---|---|---|
| low | $2.00 | 126 |
| medium | $5.00 | 80 |
| high | $25.00 | 98 |

So 206 of 304 (68%) could have reached a reviewer for $5 or less, and any review returns the whole hold. 4 of these authors had a pull request merged in the same project later. 20 contained text aimed at AI reviewers.

The model and the bots disagree a lot, and that is the point of a second door. At juice-shop it agreed with the spam detector and put most at the maximum. At scrapy it read most of what the spam workflow closed as careful. Either could be wrong. A hold lets a maintainer find out, at no cost to a newcomer acting in good faith.

| Project | Sized | $2 | $5 | $25 | Merged later |
|---|---|---|---|---|---|
| juice-shop/juice-shop | 66 | 9 | 7 | 50 | 3 |
| flathub/flathub | 54 | 8 | 29 | 17 | 0 |
| OWASP/Nettacker | 40 | 23 | 10 | 7 | 0 |
| scrapy/scrapy | 33 | 29 | 4 | 0 | 0 |
| gitroomhq/postiz-app | 30 | 11 | 13 | 6 | 0 |
| typescript-eslint/typescript-eslint | 13 | 6 | 3 | 4 | 0 |
| louislam/uptime-kuma | 13 | 9 | 3 | 1 | 0 |
| scikit-learn/scikit-learn | 11 | 6 | 2 | 3 | 0 |
| DIYgod/RSSHub | 7 | 5 | 2 | 0 | 0 |
| scrapy/parsel | 7 | 7 | 0 | 0 | 0 |
| OWASP/mastg | 5 | 3 | 0 | 2 | 0 |
| scrapinghub/dateparser | 5 | 4 | 1 | 0 | 0 |
| yt-dlp/yt-dlp | 5 | 2 | 2 | 1 | 0 |
| sxyazi/yazi | 3 | 1 | 1 | 1 | 0 |
| maxrave-dev/SimpMusic | 3 | 0 | 0 | 3 | 0 |
| carthage-software/mago | 2 | 1 | 1 | 0 | 0 |
| Agenta-AI/agenta | 1 | 0 | 1 | 0 | 0 |
| Flagsmith/flagsmith | 1 | 1 | 0 | 0 | 1 |
| huntabyte/shadcn-svelte | 1 | 0 | 0 | 1 | 0 |
| cloudflare/cloudflare-docs | 1 | 0 | 0 | 1 | 0 |
| apache/airflow | 1 | 1 | 0 | 0 | 0 |
| RPCS3/rpcs3 | 1 | 0 | 0 | 1 | 0 |
| skills/communicate-using-markdown | 1 | 0 | 1 | 0 | 0 |

## What this does not show

- A low band is not proof of good work. The model [misses tidy AI slop](../triage/RESULTS.md), placing 29% to 39% of pull requests labelled as AI slop in the high band.
- A bot may be right, and a project may want its door closed. This counts doors, it does not judge them.
- One page per project means different windows, from 2016-02-20 at the earliest, and `author_association` reflects today rather than the day the pull request opened.
- Nothing here measures whether a hold would stop slop.

## Reproduce

`node evals/doors/survey.mjs`, then `node --experimental-strip-types evals/doors/size.mjs`, then `node evals/doors/report.mjs`. GET requests only, and nothing is posted to any project. The survey's rows are in `data/`: project names, pull request numbers, times and counts, never a username or a pull request's text. The last command rebuilds this page from them alone. The sizing cost about $0.10.
