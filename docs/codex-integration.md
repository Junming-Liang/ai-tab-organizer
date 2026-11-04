# ChatGPT plan integration without Codex sessions

## First-version boundary

The first version offers offline rules and API-key AI providers only. It does **not** start Codex CLI, `codex exec`, or app-server threads; inspect Codex authentication/session files; copy existing tokens; or implement Sign in with ChatGPT (SIWC). No live OAuth or inference was performed while preparing this document.

A session-free-from-Codex integration is feasible through an official, separate route. It is future work, not a working feature or a promise of account eligibility.

## Official route

OpenAI documents ChatGPT plan usage for open-source, locally hosted apps. Eligible requests can use a separately authorized OAuth credential and the public Responses API, without running Codex. This grants neither access to ChatGPT conversations nor existing account context. Paid or remotely hosted offerings have a different intake path. See the [official overview](https://developers.openai.com/siwc/token-sharing-open-source).

API-key requests use the selected provider's API billing and may incur separate charges. They do not automatically use an existing ChatGPT subscription. SIWC-authorized requests instead use eligible ChatGPT plan usage or credits. The UI must clearly distinguish these modes and link to usage controls. See [OpenAI's usage UX guidance](https://developers.openai.com/siwc/ui-ux-guidelines).

**Independent authentication does not mean independent quota.** The official account documentation says Plus users share a five-hour allowance across participating apps; it does not assign each app a separate allowance. Therefore even a companion that never touches Codex sessions can consume shared plan capacity. Avoid promising “no impact on normal usage.” See [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Proposed companion architecture (not implemented)

1. A locally installed companion owns a stable, opaque host identifier and the app's own registration. First registration uses the documented dynamic-client flow; it needs no embedded client secret or partner API key.
2. Open the system browser for explicit authorization. Use a temporary `127.0.0.1` callback listener, fresh `state`, OIDC `nonce`, and PKCE S256. Verify state and use exactly the same callback URI for authorization and exchange.
3. Validate the ID token's signature using OpenAI JWKS, issuer, audience, expiry and nonce. Verify granted ChatGPT-plan scopes before inference. Preserve each issued client ID with its validated account identity, independently of Codex.

These requirements come from [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). This is a design outline, not a complete OAuth implementation specification.

4. Keep credentials in the companion's secure OS credential store, never in Chrome storage, logs or source control. An OS store is this project's proposed stronger storage choice. Serialize refreshes and replace rotated credentials together. Provide explicit sign-out/revocation and account selection. The source requires protected local storage and forbids browser token storage: [credential security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#credential-security).
5. The extension would communicate through tightly restricted Native Messaging. Only approved tab IDs, titles and domains would cross that boundary; no full URLs, page contents or tokens. This transport and data minimization are project design decisions, not claims of a supplied OpenAI bridge.
6. The companion would fetch the selected account's models and call `POST https://api.openai.com/v1/responses` with its own OAuth access token. Use `store: false`, `stream: true`; accept success only after `response.completed`. Handle incomplete streams and late usage failures. Do not call private ChatGPT backend endpoints. See [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
7. Return validated grouping data through the provider interface. Preserve the normal preview/apply confirmation. No agent tools, shell commands, browser tools or Codex sessions are needed for classification.

## Remaining verification before implementation

- Recheck current preview support, actual account/workspace eligibility, model availability, consent and usage-limit behavior. These have not been validated against a live account.
- Test OAuth cancellation, callback attacks, account switching, refresh rotation, revocation, unavailable OS credential storage and companion uninstall.
- Verify supported platforms, Native Messaging installation and extension-ID restrictions.
- Audit request parameters against [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The direct flow differs from generic API-key Responses usage; several fields are unsupported, and HTTP requests do not use persistent conversation references.
- Recheck applicable distribution and branding requirements. A public GitHub repository alone does not establish successful registration or permission for a particular account.

Reviewed against official documentation on 2026-11-04. No executable companion or authentication flow is included in this version.
