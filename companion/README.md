# Independent SIWC companion (experimental, local only)

This Python companion owns its **own** Sign in with ChatGPT registration. It never starts Codex, creates a Codex session, imports Codex code, or reads Codex credentials/session files. It calls the public Responses API directly. Independent login does **not** provide an independent plan allowance.

**Status:** implemented and tested with synthetic OAuth/JWT/SSE/Native Messaging fixtures. Real account eligibility, browser OAuth, OS keychain behavior and installed Chrome-to-companion operation have **not** been validated. Do not treat this as a production authentication integration. Version 0.2.0-dev has not been published.

## Supported systems

- Python 3.11+, macOS with an unlocked Keychain or Linux with an unlocked Secret Service session.
- Google Chrome 120+.
- Windows, Chromium/Edge installation paths, KWallet-only environments, headless servers and remote hosting are not supported by this experimental installer.
- The selected OS credential backend must work. There is **no** plaintext-file, environment-token, browser-token or alternate-keyring fallback.

Use a dedicated virtual environment. The native launcher uses Python isolated mode, so a user-site-only install is not sufficient. Run from the repository root:

```sh
python3 -m venv companion/.venv
companion/.venv/bin/python -m pip install ./companion
```

This installs PyJWT with its cryptography dependency and keyring from the configured Python registry. Review the source and dependency sources before installation. The extension itself remains dependency-free.

## Explicit setup

These steps create persistent access and send account authorization data to OpenAI. They must be performed intentionally by the user, not silently by the extension.

1. Load the `extension/` folder from `chrome://extensions`, then copy its 32-letter extension ID.
2. Authorize **only that ID** in Chrome's local Native Messaging configuration:

```sh
companion/.venv/bin/ai-tab-companion install-host --extension-id YOUR_EXTENSION_ID --confirm-install
```

3. Sign in independently. The companion opens the system browser at OpenAI, listens briefly only on `127.0.0.1`, and saves tokens only after validating the completed authorization:

```sh
companion/.venv/bin/ai-tab-companion login
```

4. In extension settings choose **ChatGPT / SIWC**, click **Continue with ChatGPT**, grant the optional Native Messaging permission, then check the connection. This button connects to the already installed companion; it does not start OAuth. Choose a model from the current account's catalog, review the metadata/shared-usage consent and save.
5. Use synthetic, non-sensitive tab titles for initial validation. Generate a preview, inspect it, then apply. The first real classification consumes eligible ChatGPT plan capacity.

No existing Codex credentials are imported. There is no API-key billing fallback. Manage shared usage and app access in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

## Accounts and recovery

```sh
companion/.venv/bin/ai-tab-companion accounts
companion/.venv/bin/ai-tab-companion use ACCOUNT_ID
companion/.venv/bin/ai-tab-companion login --account ACCOUNT_ID
companion/.venv/bin/ai-tab-companion login --retry-registration
companion/.venv/bin/ai-tab-companion logout
companion/.venv/bin/ai-tab-companion status
```

`login` without `--account` explicitly adds a new account/workspace registration. Reauthorize a saved account with `--account`, reusing its issued client ID. The status/account ID is an app-specific non-secret hash, not an OAuth token or account identifier. After switching accounts, refresh the extension's account/model selection and reconfirm consent. Classification rejects stale bindings instead of silently using another account.

If a first registration reaches the callback but token exchange fails, `--retry-registration` reuses the pending issued client ID; it does not activate an unverified identity. If plan scopes were not granted, requests fail closed. Use `login --account ACCOUNT_ID --consent` (or `--retry-registration --consent`) to explicitly ask OpenAI for consent again. Eligibility remains controlled by OpenAI.

Logout attempts remote refresh-token revocation, then removes local access/refresh/ID tokens while retaining the registration and stable host identity. If revocation cannot be confirmed, the CLI explicitly reports that and links to ChatGPT settings. This does not revoke other apps or sign Codex out.

To disconnect the extension, remove its optional Native Messaging permission in Chrome. To uninstall the bridge, remove only `com.ai_tab_organizer.siwc.json` from the Chrome NativeMessagingHosts folder and this app's generated `native-host` launcher. Log out each account and disconnect the app in ChatGPT settings first. Removing the extension alone does **not** erase companion credentials from the OS keychain.

## Storage and transport

- The app's private configuration directory is `~/Library/Application Support/AI Tab Organizer` on macOS, or `~/.config/ai-tab-organizer` on Linux. It contains the stable random host ID, one allowed extension ID, a lock file and a launcher. No token files are written there.
- The OS keychain item uses service `ai-tab-organizer.siwc`, account `independent-accounts-v1`. It holds separate registrations, verified identity, tokens and scopes in one replaced item. No tokens are sent to the browser.
- Chrome's native manifest uses one exact `chrome-extension://ID/` origin. The helper checks it at launch and again under the process lock for every request.
- Only `status`, `models` and `classify` exist in the extension protocol. There are no shell, arbitrary URL, login or token-export commands.
- `classify` accepts only account binding, model, category hints and numeric IDs/titles/domains. Both sides validate IDs. Fixed OpenAI endpoints, no redirects, no inherited HTTP proxy, no tools, no persistent conversation references.
- A cross-process lock serializes account changes and rotating refreshes. The network layer shares a 50-second budget checked around operations; this is not a guaranteed hard DNS/HTTP wall-clock deadline. The extension has a 90-second outer timeout. Inference is never automatically retried.

## Tests

```sh
companion/.venv/bin/python -m unittest discover -s companion/tests -v
```

All fixtures use ephemeral signing keys and synthetic metadata. Tests never invoke a real login, keychain, native-host installation outside a temporary folder, Codex, or paid inference. See [the security design](../docs/codex-integration.md) and [validation checklist](../docs/testing.md).
