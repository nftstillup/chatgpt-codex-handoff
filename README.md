# chatgpt-codex-handoff

A restricted, auditable handoff bridge between ChatGPT-compatible MCP clients and Codex-oriented local workers.

> Status: early open-source candidate. Clean installation, TypeScript build, focused tests, and a synthetic queue demo have been verified locally. Real Codex/private-tunnel re-verification is still pending.

## What this project is

This project focuses on a deliberately narrow handoff model:

- publish a reviewed project summary
- submit a bounded task against a specific summary version
- queue work with request-id idempotency
- claim work using a one-time receipt
- publish only reviewed terminal results
- expose limited MCP handoff tools instead of arbitrary filesystem or shell access

The goal is to make ChatGPT to Codex handoff more explicit, bounded, and auditable.

## Origin

This is a derivative project based on:

https://github.com/XiaoDuoYa/codex-with-chatgpt

The upstream project and its broader workspace bridge are the work of the original maintainers.

This repository separates and develops a restricted handoff mode derived from that codebase. It does not claim the upstream project, its users, stars, adoption, or original functionality as the work of this repository's maintainer.

The upstream MIT license is preserved in LICENSE.

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

## Verified locally

Verified on 2026-09-17 on Windows with Node.js 24.15.0 and TypeScript 5.9.3:

- TypeScript typecheck: passed
- TypeScript build: passed
- tests/handoff.test.ts: 9 passed
- tests/handoff-integration.test.ts: 5 passed
- total focused tests: 14 / 14 passed
- synthetic queue demo: passed

The synthetic demo does not invoke a real Codex model or private tunnel.

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

- Node.js 20 or newer
- pnpm 11.24.0 via Corepack

Typical commands:

    corepack pnpm install
    corepack pnpm typecheck
    corepack pnpm build
    corepack pnpm test
    node examples/synthetic-demo.mjs

A clean installation from this extracted repository was independently verified on Windows on 2026-09-18 using pnpm 11.24.0.

## Security model

Important limitations:

- sensitive-text checks are a secondary safeguard, not a complete sanitizer
- reviewed summaries are trusted assertions, not automatic proof of safe disclosure
- read-only model policy is not equivalent to operating-system sandboxing
- optional worker execution still requires local review of permissions and environment
- no production credentials, private runtime state, or user data should be committed to this repository

## License

MIT.

See LICENSE for the preserved upstream license notice and terms.
