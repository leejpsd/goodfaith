# Contributing

Bug reports and pull requests are welcome, including from people we have never met.

## Getting started

Follow "Run it locally" in the README. `npm test` needs no database or keys, because tests run against an in-memory Postgres and fake PayPal and GitHub clients.

## Before you open a pull request

- Run `npx tsc --noEmit` and `npm test`.
- Say what the change fixes, and how you checked it.
- Keep the money rules in `src/lib/hold.ts` pure, and add a test for any new state or effect.
- A model's output must never decide whether money moves. It can suggest a band and write a brief, and code does the rest.

## Reporting a security problem

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository.

## Conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
