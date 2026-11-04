# Independent ChatGPT plan integration

## Current status

The local **0.2.0-dev** adds an experimental Python SIWC companion and a Chrome Native Messaging provider. It does not launch Codex CLI, app-server or any Codex session, and never reads Codex account material. The published 0.1.0 remains API-key/offline only until this change is separately reviewed and published.

Synthetic tests cover the implementation. Live OAuth, OS credential-store integration and real plan usage remain unverified and require explicit user authorization. Do not claim that this works for every account or consumes a separate allowance. See the [setup guide](../companion/README.md).

## Security boundaries

1. **Independent registration.** A stable app-owned host ID is stored before authorization. New registration uses OpenAI's dynamic public-client flow; returning registration reuses its own issued client ID. Neither a commercial client secret nor an existing Codex token is embedded. An interrupted first registration retains only its pending issued ID, never an active unverified account.
2. **Explicit browser authorization.** Login is a CLI action, never triggered automatically by classification. The system browser opens OpenAI's authorization endpoint. A temporary listener binds only `127.0.0.1`, with fixed callback path, exact URI reuse, fresh state/nonce and PKCE S256. Repeated fields, wrong origins/path/state and replays are rejected. Idle and absolute connection timeouts prevent a stalled local connection holding the login lock forever.
3. **Validated identity.** PyJWT verifies RS256 against the fixed OpenAI JWKS, exact issuer, issued-client audience, expiry/issued-at and nonce. Reauthorization must retain the verified subject. Optional token/code hash claims are checked. Registration identity is issuer + issued client ID + verified subject; email is display-only.
4. **Credentials stay outside Chrome.** Explicit macOS Keychain or Linux Secret Service adapters store a single account-state item. No plaintext fallback, token logging, environment-token import, browser storage or secret command-line parameters. Native launcher uses an isolated Python environment. A missing or locked store blocks work.
5. **Rotation and sign-out.** A cross-process lock protects account selection and token rotation. Renewed credentials are saved together before inference. Terminal refresh failures clear only the affected account's tokens; transient failures preserve them. Logout attempts revocation and discloses when remote revocation was not confirmed. Registration/host identity survive logout for later sign-in.
6. **Restricted bridge.** One exact extension origin is allowed; every message rechecks it. Only status, account-specific models and classification are exposed. No arbitrary endpoints, headers, shell, tools or token exports. Requests and responses are size-limited, and the extension retains only a non-secret account-binding hash and display label.
7. **Stateless inference.** The selected account's listed models are fetched from OpenAI. Classification calls the public Responses endpoint with `store:false`, `stream:true` and only supported fields. No `conversation` or `previous_response_id`. Only a completed canonical assistant text output can become a plan; refusal, incomplete/failed events, interrupted streams or unexpected tools fail closed. Unknown/duplicate tag IDs are rejected twice. No automatic retry or API-key fallback.

## Permissions and cost

The extension requests Native Messaging only when the user selects and connects the optional SIWC mode. Installing the local host authorizes one specified extension ID. OAuth grants persistent access until revoked, and real inference can consume shared ChatGPT plan capacity. Independent login does not mean independent quota or no effect on other apps. [Manage usage and access](https://chatgpt.com/settings/usage).

API-key mode remains separately billed by the selected provider. The two consent settings, model choices and credentials are independent. A changed companion account invalidates the saved selection and requires renewed confirmation before sending tab metadata.

## Validation still required

- Real macOS Keychain / Linux Secret Service access and locked-store recovery.
- Real callback/cancel/reauthorization, workspace eligibility, models and usage-limit behavior.
- Installed host origin restrictions and browser restart/uninstall behavior on supported OSs.
- Third-party security review before treating the authentication integration as production-ready.
- Windows packaging and credential storage are not implemented.

## Official references

Reviewed 2026-11-04:

- [OSS registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts, rotation, revocation and credential security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OAuth error recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Published OIDC configuration](https://auth.openai.com/.well-known/openid-configuration)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Keyring platform backends](https://keyring.readthedocs.io/en/latest/)

This is a project security design, not a claim of official endorsement or an independent security audit.
