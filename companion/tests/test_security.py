import copy
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.parse

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from ai_tab_companion.security import SafeError, AUTH, TOKEN, RESOURCE, strict_json, auth_url, NoRedirect, OAuthError
from ai_tab_companion.oauth import Attempt, Validator, Session, token_record, registration_key, JWKS
from ai_tab_companion.storage import Config, Vault
from ai_tab_companion.inference import Inference, consume_sse, payload, validate_groups
from ai_tab_companion.native import read_message, write_message, verify_origin, handle, MAX_MESSAGE
from ai_tab_companion.cli import install_host


class MemoryVault:
    def __init__(self, data=None):
        self.data = data or {"accounts": {}, "active": None}
        self.fail = False
        self.saves = 0
    def load(self):
        return copy.deepcopy(self.data)
    def save(self, data):
        if self.fail:
            raise SafeError("测试钥匙串不可用。")
        self.data = copy.deepcopy(data)
        self.saves += 1


class Response(io.BytesIO):
    headers = {"Content-Type": "text/event-stream"}
    status = 200


class HTTP:
    def __init__(self, results=None, stream=b""):
        self.results = results or {}
        self.stream = stream
        self.calls = []
    def json(self, url, **kwargs):
        self.calls.append((url, kwargs))
        value = self.results[url]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)
    def open(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return Response(self.stream)


def event(kind, **fields):
    return ("data: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()


def grant(**updates):
    result = {"access_token": "test-access-placeholder", "refresh_token": "test-refresh-placeholder", "id_token": "test-id-placeholder", "expires_in": 3600, "token_type": "Bearer", "scope": "openid resource.invoke chatgpt.tokens.use.direct offline_access"}
    result.update(updates)
    return result


def record(**updates):
    result = token_record(grant(), "issued-test-client", {"sub": "test-sub", "email": "test@example.invalid"})
    result.update(updates)
    return result


TABS = [{"id": 1, "title": "Code docs", "domain": "github.com"}, {"id": 2, "title": "Docs", "domain": "python.org"}]
GROUPS = {"groups": [{"title": "开发", "color": "blue", "tabIds": [1, 2]}]}


def completed():
    return event("response.completed", response={"status": "completed", "output": [{"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": json.dumps(GROUPS)}]}]})


class OAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.private.public_key()))
        cls.public.update(kid="test-key", alg="RS256", use="sig")

    def signed(self, **changes):
        claims = {"iss": AUTH, "aud": "issued-test-client", "sub": "test-sub", "iat": int(time.time()), "exp": int(time.time()) + 600, "nonce": "expected-nonce"}
        claims.update(changes)
        return jwt.encode(claims, self.private, algorithm="RS256", headers={"kid": "test-key"})

    def validator(self):
        return Validator(HTTP({JWKS: {"keys": [self.public]}}))

    def test_pkce_state_nonce_and_new_registration(self):
        a = Attempt("host-test", "http://127.0.0.1:1234/auth/callback")
        b = Attempt("host-test", a.redirect_uri)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(a.url()).query)
        self.assertEqual(query["client_id"], ["dynamic_agent_client"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertNotIn(a.verifier, a.url())
        self.assertNotEqual(a.state, b.state)
        self.assertNotEqual(a.nonce, b.nonce)
        form = a.callback("/auth/callback?state=" + a.state + "&client_id=issued-test-client&code=test-code")
        self.assertEqual(form["redirect_uri"], a.redirect_uri)
        self.assertEqual(form["client_id"], "issued-test-client")
        self.assertEqual(form["code_verifier"], a.verifier)
        with self.assertRaises(SafeError):
            a.callback("/auth/callback?state=" + a.state + "&code=test-code")

    def test_callback_attacks(self):
        for suffix in ("state=bad&code=x", "state=恶意&code=x", "state={s}&state={s}&code=x", "state={s}&code=x", "state={s}&client_id=dynamic_agent_client&code=x"):
            with self.subTest(suffix=suffix):
                a = Attempt("host", "http://127.0.0.1:1/auth/callback")
                with self.assertRaises(SafeError):
                    a.callback("/auth/callback?" + suffix.format(s=a.state))
        for path in ("/wrong", "http://evil.invalid/auth/callback", "/auth/callback#fragment"):
            with self.assertRaises(SafeError):
                Attempt("host", "uri").callback(path)

    def test_denial_validates_state_first_and_is_consumed(self):
        a = Attempt("host", "uri")
        with self.assertRaises(SafeError):
            a.callback("/auth/callback?error=access_denied&state=bad")
        self.assertFalse(a.used)
        with self.assertRaises(SafeError):
            a.callback("/auth/callback?error=access_denied&state=" + a.state)
        self.assertTrue(a.used)

    def test_consent_screen_only_when_explicitly_requested(self):
        self.assertNotIn("prompt=consent", Attempt("host", "uri", record()).url())
        self.assertIn("prompt=consent", Attempt("host", "uri", record(), force_consent=True).url())

    def test_returning_client_cannot_be_replaced(self):
        a = Attempt("host", "uri", record())
        self.assertNotIn("agent_name_hint", a.url())
        self.assertNotIn("id_token_hint", a.url())
        with self.assertRaises(SafeError):
            a.callback("/auth/callback?state=" + a.state + "&code=x&client_id=different")

    def test_jwt_signature_and_claim_checks(self):
        self.assertEqual(self.validator().verify(self.signed(), "issued-test-client", "expected-nonce")["sub"], "test-sub")
        for changes in ({"iss": "https://evil.invalid"}, {"aud": "other-client"}, {"exp": int(time.time()) - 200}, {"nonce": "wrong"}, {"sub": ""}, {"iat": int(time.time()) + 200}, {"aud": ["issued-test-client", "other"], "azp": "other"}):
            with self.subTest(changes=changes), self.assertRaises(SafeError):
                self.validator().verify(self.signed(**changes), "issued-test-client", "expected-nonce")
        with self.assertRaises(SafeError):
            self.validator().verify(self.signed(), "issued-test-client", "expected-nonce", subject="other-sub")
        wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        bad = jwt.encode({"iss": AUTH}, wrong_key, algorithm="RS256", headers={"kid": "test-key"})
        with self.assertRaises(SafeError):
            self.validator().verify(bad, "issued-test-client")

    def test_missing_or_ambiguous_jwks_rejected(self):
        for keys in ([], [self.public, self.public]):
            with self.assertRaises(SafeError):
                Validator(HTTP({JWKS: {"keys": keys}})).verify(self.signed(), "issued-test-client", "expected-nonce")
        unsigned = jwt.encode({"iss": AUTH}, "", algorithm="none")
        with self.assertRaises(SafeError):
            self.validator().verify(unsigned, "issued-test-client")

    def test_token_scope_and_type_not_callback_scope(self):
        for updates in ({"scope": "openid"}, {"scope": None}, {"token_type": "mac"}, {"expires_in": 0}, {"access_token": "bad\ntoken"}):
            with self.assertRaises(SafeError):
                token_record(grant(**updates), "client", {"sub": "sub"})

    def test_complete_keeps_other_accounts_and_separates_client_ids(self):
        old = record()
        key = registration_key(old)
        vault = MemoryVault({"accounts": {key: old}, "active": key})
        a = Attempt("host", "uri")
        signed = self.signed(aud="new-client", nonce=a.nonce)
        http = HTTP({TOKEN: grant(id_token=signed), JWKS: {"keys": [self.public]}})
        new = Session(vault, None, http).complete(a, {"client_id": "new-client"})
        self.assertNotEqual(key, new)
        self.assertEqual(len(vault.data["accounts"]), 2)
        self.assertEqual(vault.data["accounts"][key], old)
        self.assertEqual(vault.data["active"], new)

    def test_refresh_rotation_is_saved_before_use(self):
        old = record(expires_at=1)
        key = registration_key(old)
        vault = MemoryVault({"accounts": {key: old}, "active": key})
        new = grant(access_token="new-access-placeholder", refresh_token="new-refresh-placeholder")
        del new["id_token"]
        del new["scope"]
        http = HTTP({TOKEN: new})
        session = Session(vault, None, http)
        self.assertEqual(session.access(), new["access_token"])
        self.assertEqual(vault.data["accounts"][key]["refresh_token"], new["refresh_token"])
        self.assertNotIn("scope", http.calls[0][1]["form"])
        self.assertEqual(http.calls[0][1]["form"]["client_id"], old["client_id"])
        vault.data["accounts"][key]["expires_at"] = 1
        vault.fail = True
        with self.assertRaises(SafeError):
            session.access()

    def test_failed_refresh_preserves_account(self):
        old = record(expires_at=1)
        key = registration_key(old)
        vault = MemoryVault({"accounts": {key: old}, "active": key})
        session = Session(vault, None, HTTP({TOKEN: SafeError("网络不可用。")}))
        with self.assertRaises(SafeError):
            session.access()
        self.assertEqual(vault.data["accounts"][key], old)

    def test_logout_failure_clears_tokens_not_registration(self):
        from ai_tab_companion.security import DISCOVERY
        old = record()
        key = registration_key(old)
        vault = MemoryVault({"accounts": {key: old}, "active": key})
        session = Session(vault, None, HTTP({DISCOVERY: SafeError("网络不可用。")}))
        with patch("ai_tab_companion.oauth.time.sleep"):
            self.assertFalse(session.logout())
        self.assertEqual(vault.data["accounts"][key]["client_id"], old["client_id"])
        self.assertNotIn("refresh_token", vault.data["accounts"][key])
        self.assertNotIn("id_token", vault.data["accounts"][key])
        self.assertFalse(session.status()["connected"])


    def test_malformed_revocation_discovery_still_signs_out_locally(self):
        from ai_tab_companion.security import DISCOVERY
        for endpoint in (7, {}, [], None, "http://untrusted.invalid/revoke"):
            old = record()
            key = registration_key(old)
            vault = MemoryVault({"accounts": {key: old}, "active": key})
            http = HTTP({DISCOVERY: {"issuer": AUTH, "revocation_endpoint": endpoint}})
            with patch("ai_tab_companion.oauth.time.sleep"):
                self.assertFalse(Session(vault, None, http).logout())
            self.assertNotIn("access_token", vault.data["accounts"][key])
            self.assertNotIn("refresh_token", vault.data["accounts"][key])
            self.assertEqual(vault.data["accounts"][key]["client_id"], old["client_id"])

    def test_terminal_refresh_error_clears_only_affected_tokens(self):
        old = record(expires_at=1)
        key = registration_key(old)
        other = record(client_id="other-client")
        other_key = registration_key(other)
        vault = MemoryVault({"accounts": {key: old, other_key: other}, "active": key})
        with self.assertRaises(OAuthError):
            Session(vault, None, HTTP({TOKEN: OAuthError("refresh_token_reused")})).access()
        self.assertNotIn("refresh_token", vault.data["accounts"][key])
        self.assertEqual(vault.data["accounts"][key]["client_id"], old["client_id"])
        self.assertEqual(vault.data["accounts"][other_key], other)

    def test_incomplete_registration_retains_issued_id_without_activation(self):
        old = record()
        key = registration_key(old)
        vault = MemoryVault({"accounts": {key: old}, "active": key})
        session = Session(vault, None, HTTP({TOKEN: OAuthError("invalid_grant")}))
        with self.assertRaises(OAuthError):
            session.complete(Attempt("host", "uri"), {"client_id": "new-client"})
        self.assertEqual(vault.data["pending_registration"], {"client_id": "new-client"})
        self.assertEqual(vault.data["accounts"][key], old)
        self.assertEqual(vault.data["active"], key)

    def test_optional_token_hashes_are_verified(self):
        from ai_tab_companion.oauth import b64
        import hashlib
        access = "test-access-placeholder"
        digest = b64(hashlib.sha256(access.encode()).digest()[:16])
        self.validator().verify(self.signed(at_hash=digest), "issued-test-client", "expected-nonce", access_token=access)
        with self.assertRaises(SafeError):
            self.validator().verify(self.signed(at_hash=digest), "issued-test-client", "expected-nonce", access_token="different")


class InferenceTests(unittest.TestCase):
    def request(self):
        return {"accountId": "a"*16, "model": "test-model", "categories": "开发", "tabs": copy.deepcopy(TABS)}

    def test_metadata_rejects_extra_private_fields(self):
        for extra in ("url", "body", "cookie", "access_token"):
            value = self.request()
            value["tabs"][0][extra] = "not-allowed"
            with self.assertRaises(SafeError):
                payload(value)
        for domain in ("github.com/private?q=x", "user:pass@github.com", "github.com#secret", "github.com:443", "github.com:0", "example.com\n"):
            value = self.request()
            value["tabs"][0]["domain"] = domain
            with self.assertRaises(SafeError):
                payload(value)
        self.assertEqual(payload(self.request()), self.request())

    def test_response_group_ids_strict(self):
        self.assertEqual(validate_groups(json.dumps(GROUPS), TABS), GROUPS)
        for ids in ([1, 999], [1, 1], [True, 2], ["1", 2]):
            groups = copy.deepcopy(GROUPS)
            groups["groups"][0]["tabIds"] = ids
            with self.assertRaises(SafeError):
                validate_groups(json.dumps(groups), TABS)

    def test_sse_requires_completed(self):
        delta = event("response.output_text.delta", delta=json.dumps(GROUPS))
        done = completed()
        self.assertEqual(json.loads(consume_sse(Response(delta + done))), GROUPS)
        for suffix in (b"", b"data: [DONE]\n\n", event("response.failed", response={"error": {"code": "subscription_sharing_usage_limit_exceeded"}}), event("response.incomplete"), event("response.completed", response={"status": "failed"})):
            with self.assertRaises(SafeError):
                consume_sse(Response(delta + suffix))

    def test_sse_canonical_text_over_delta(self):
        stream = event("response.output_text.delta", delta="partial") + event("response.completed", response={"status": "completed", "output": [{"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": json.dumps(GROUPS)}]}]})
        self.assertEqual(json.loads(consume_sse(Response(stream))), GROUPS)

    def test_sse_bounds_and_malformed_data(self):
        for data in (b"x"*512001, b"data: no-json\n\n", b'data: {"type":"error","type":"response.completed"}\n\n'):
            with self.assertRaises(SafeError):
                consume_sse(Response(data))

    def test_models_and_responses_fixed_contract(self):
        class Selected:
            def access(self):
                return "test-access-placeholder"
            def status(self):
                return {"accountId": "a"*16, "account": "Test"}
        models = {"models": [{"slug": "hidden", "display_name": "Hidden", "visibility": "hidden"}, {"slug": "test-model", "display_name": "Model", "visibility": "list"}]}
        http = HTTP({RESOURCE+"/models": models}, event("response.output_text.delta", delta=json.dumps(GROUPS)) + completed())
        inference = Inference(Selected(), http)
        self.assertEqual(inference.classify(self.request()), GROUPS)
        url, args = http.calls[-1]
        self.assertEqual(url, RESOURCE+"/responses")
        self.assertEqual(set(args["body"]), {"model", "instructions", "input", "store", "stream"})
        self.assertIs(args["body"]["store"], False)
        self.assertIs(args["body"]["stream"], True)
        self.assertEqual(json.loads(args["body"]["input"][0]["content"]), {"categories": "开发", "tabs": TABS})
        value = self.request(); value["accountId"] = "b"*16
        before = len(http.calls)
        with self.assertRaises(SafeError):
            inference.classify(value)
        self.assertEqual(len(http.calls), before)


    def test_completed_refusal_or_missing_body_never_uses_prior_deltas(self):
        delta = event("response.output_text.delta", delta=json.dumps(GROUPS))
        for output in ([], [{"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "refusal", "refusal": "No"}]}], [{"type": "function_call", "name": "evil"}], [{"type": "message", "role": "assistant", "status": "incomplete", "content": []}]):
            with self.assertRaises(SafeError):
                consume_sse(Response(delta + event("response.completed", response={"status": "completed", "output": output})))


class StorageAndProtocolTests(unittest.TestCase):
    def test_request_deadline_prevents_another_network_call(self):
        from ai_tab_companion.security import Http
        client = Http()
        client.begin_request(seconds=-1)
        with patch.object(client.opener, "open") as request:
            with self.assertRaises(SafeError):
                client.json(RESOURCE + "/models", token="test-access-placeholder")
            request.assert_not_called()

    def test_strict_json_and_redirects(self):
        for raw in ('{"a":1,"a":2}', '{"n":NaN}'):
            with self.assertRaises(SafeError):
                strict_json(raw)
        for url in ("https://auth.openai.com.evil.invalid/x", "http://auth.openai.com/x", "https://user@auth.openai.com/x"):
            with self.assertRaises(SafeError):
                auth_url(url)
        with self.assertRaises(SafeError):
            NoRedirect().redirect_request(None, None, 302, None, None, "https://evil.invalid")

    def test_private_config_host_stable_and_process_lock(self):
        with tempfile.TemporaryDirectory() as root:
            config = Config(Path(root)/"state")
            host = config.host_id()
            self.assertEqual(host, Config(config.home).host_id())
            self.assertEqual(os.stat(config.path).st_mode & 0o777, 0o600)
            with config.lock():
                with self.assertRaises(SafeError):
                    with Config(config.home).lock():
                        pass
            config.path.unlink()
            config.path.symlink_to(Path(root)/"not-config")
            with self.assertRaises(OSError):
                config.read()

    def test_unsupported_vault_has_no_plaintext_fallback(self):
        with patch("ai_tab_companion.storage.sys.platform", "win32"):
            with self.assertRaises(SafeError):
                Vault()

    def test_vault_failure_is_closed_and_safe(self):
        class Broken:
            def get_password(self, *_):
                raise RuntimeError("never echo provider secrets")
            def set_password(self, *_):
                raise RuntimeError("never echo provider secrets")
        vault = Vault.__new__(Vault)
        vault.backend = Broken()
        for call in (vault.load, lambda: vault.save({"x": "y"})):
            with self.assertRaises(SafeError) as caught:
                call()
            self.assertNotIn("secrets", str(caught.exception))

    def test_native_size_truncation_and_roundtrip(self):
        data = {"id": "request-1", "type": "status"}
        stream = io.BytesIO()
        write_message(stream, data)
        stream.seek(0)
        self.assertEqual(read_message(stream), data)
        self.assertIsNone(read_message(stream))
        for raw in (struct.pack("=I", MAX_MESSAGE+1), b"\x01", struct.pack("=I", 10)+b"{}"):
            with self.assertRaises(SafeError):
                read_message(io.BytesIO(raw))

    def test_install_is_single_origin_and_owner_only(self):
        with tempfile.TemporaryDirectory() as root:
            config = Config(Path(root)/"state")
            with config.lock():
                path = install_host(config, "a"*32, destination=Path(root)/"chrome")
            manifest = json.loads(path.read_text())
            self.assertEqual(manifest["allowed_origins"], ["chrome-extension://"+"a"*32+"/"])
            self.assertEqual(os.stat(manifest["path"]).st_mode & 0o777, 0o700)
            verify_origin(manifest["allowed_origins"][0], config)
            with self.assertRaises(SafeError):
                verify_origin("chrome-extension://"+"b"*32+"/", config)
            self.assertNotIn("token", Path(manifest["path"]).read_text())

    def test_native_surface_cannot_start_login_or_arbitrary_requests(self):
        for message in ({"id": "1", "type": "login"}, {"id": "1", "type": "status", "url": "https://evil.invalid"}, {"id": "1", "type": "shell"}):
            with self.assertRaises(SafeError):
                handle(message, None, None)


if __name__ == "__main__":
    unittest.main()
