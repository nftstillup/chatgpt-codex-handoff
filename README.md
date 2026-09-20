# chatgpt-codex-handoff

A restricted, auditable handoff bridge between ChatGPT-compatible MCP clients and Codex-oriented local workers.

> Status: early open-source candidate. Clean installation, TypeScript build, focused tests, and a synthetic queue demo have been verified locally. Real Codex/private-tunnel re-verification is still pending.

## What this project is

This project focuses on a deliberately narrow handoff model:

- publish a reviewed project summary
- submit a bounded task against a specific summary version
- queue work with request-id idempotency
- claim work using a one-time receipt
- publish locally reviewed summaries or fixed worker status messages
- expose limited MCP handoff tools instead of arbitrary filesystem or shell access

The goal is to make ChatGPT to Codex handoff more explicit, bounded, and auditable.

## Origin

This is a derivative project based on:

https://github.com/XiaoDuoYa/codex-with-chatgpt

The upstream project and its broader workspace bridge are the work of the original maintainers.

This repository separates and develops a restricted handoff mode derived from that codebase. It does not claim the upstream project, its users, stars, adoption, or original functionality as the work of this repository's maintainer.

The upstream MIT license is preserved in LICENSE.

The extraction started from a local upstream checkout at commit
`8fdd97c188c7678d0d9c43b3769b426940de568a`, including later local handoff work.
That commit identifies the upstream baseline, not a commit containing all of
this repository's handoff implementation.

| Area | Origin and changes |
| --- | --- |
| Auth, pairing, HTTP transport, logging, configuration helpers | Inherited from upstream; OAuth was extended with restricted handoff scopes and matching consent text. |
| `src/handoff/`, the two handoff test suites | Local restricted-handoff work implemented and maintained after that upstream baseline, then extracted here. |
| README, synthetic demo, package/lockfile, project identity | Packaging and documentation for this derivative repository. |

This is a description of the extraction, not a claim that every line in an
adapted module is original work by this repository's maintainer.

## Current scope

The extracted code currently includes:

- bounded handoff queue and persistence
- reviewed summary versioning
- request-id idempotency
- task ownership and status reporting
- one-time claim receipts
- restricted MCP handoff interface
- loopback-only local control endpoints
- optional text-worker integration
- isolated source-copy support
- optional private-ingress code path
- synthetic integration tests

This repository is not a general remote-control bridge.

It does not grant arbitrary shell access, arbitrary workspace paths, deployment access, or unrestricted local file access through the public handoff interface.

The supported walkthrough below is a synthetic queue demo. The bridge is
currently a programmatic module (`startHandoffBridge`), with local HTTP/MCP usage
demonstrated in `tests/handoff-integration.test.ts`; there is no packaged CLI or
turnkey ChatGPT connection setup. Text workers, isolated source copies and private
ingress remain experimental integration paths. The focused tests do not execute
those paths, and no snapshot-preparation or tunnel setup is included.

## Verified locally

Verified on 2026-09-19 on Windows with Node.js 24.15.0, Corepack 0.34.6,
pnpm 11.24.0 and TypeScript 5.9.3:

- clean dependency installation with `--frozen-lockfile --ignore-scripts`: passed
- TypeScript typecheck: passed
- TypeScript build: passed
- tests/handoff.test.ts: 9 passed
- tests/handoff-integration.test.ts: 7 passed, including same-origin OAuth form
  requests and rejection checks for other origins, routes, methods, content types,
  proxy headers and spoofed Host headers
- total focused tests: 16 / 16 passed
- synthetic queue demo: passed
- separate production-only dependency installation and built bridge import: passed
  (no server or worker was started for this import check)

The synthetic demo does not invoke a real Codex model or private tunnel.
HTTP integration tests use temporary synthetic data and loopback listeners with
no text worker or private ingress enabled. The OAuth tests simulate request
headers; they are not an end-to-end browser or ChatGPT connection test.

Real Codex and private-tunnel behavior must be re-verified independently for this extracted repository before being described as currently validated.

## Synthetic demo

After building, run:

    node examples/synthetic-demo.mjs

The demo uses only temporary synthetic data and exercises:

    publish
      |
    submit
      |
    claim
      |
    report
      |
    status

A successful run ends with final status "succeeded".

## Development

Requirements:

- Node.js 24.15.0 or a later 24.x release (the supported Node.js range)
- pnpm 11.24.0 via Corepack
- Corepack installed and available on PATH; verification used Corepack 0.34.6

Check `node --version` and `corepack --version` before continuing. If Corepack is
missing, install it first (`npm install --global corepack@0.34.6`). The explicit
`corepack pnpm` commands below do not require enabling global pnpm shims.

Typical commands:

    corepack pnpm install --frozen-lockfile --ignore-scripts
    corepack pnpm typecheck
    corepack pnpm build
    corepack pnpm test
    node examples/synthetic-demo.mjs

The commands above were verified on Windows on 2026-09-19 using the versions
listed under Verified locally.

`typecheck` checks `src`, while Vitest runs the test files. TypeScript is also a
runtime dependency because isolated source-copy tests use its transpiler.

## Security model

Important limitations:

- sensitive-text checks are a secondary safeguard, not a complete sanitizer
- reviewed summaries are trusted assertions, not automatic proof of safe disclosure
- the optional worker publishes fixed status messages automatically; raw model output remains local, and `succeeded` does not establish human acceptance of that output
- same-origin form submissions are accepted only on the local OAuth authorization endpoint; browser-origin requests to MCP and local-management endpoints remain blocked
- read-only model policy is not equivalent to operating-system sandboxing
- optional worker execution still requires local review of permissions and environment
- no production credentials, private runtime state, or user data should be committed to this repository

## License

MIT.

See LICENSE for the preserved upstream license notice and terms.
