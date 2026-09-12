# aikeysapi / ZhiFlow API contract

> Scope: read-only contract note for `www.aikeysapi.com`, based on the internal ZhiFlow design note and unauthenticated public HTTP observations. No registrations, token generation, key use, or production-code changes were performed.
>
> Status: in progress; this file is written incrementally after each verified section.

## 1. Scope and evidence

- **Base host:** `https://www.aikeysapi.com`
- **Product/UI:** ZhiFlow · 智流AI, a New API-compatible service.
- **Evidence classes:**
  - **Design-note evidence** — previously verified live flow recorded in `D:\WORMALIENAIGIGANT\wiki\abuse-hub\aikeysapi — вкладка ZhiFlow (дизайн).md` (11–12 Sep 2026).
  - **This-pass HTTP evidence** — only unauthenticated `GET` requests made during this pass; no credentials or account artefacts are used.
- **Out of scope:** registration, email verification, login, token creation/reveal, model invocation, browser automation, Cloudflare bypassing, or source-code modifications.

## 2. Contract summary

Pending live read-only verification of `/api/status` and `/v1/models`.
