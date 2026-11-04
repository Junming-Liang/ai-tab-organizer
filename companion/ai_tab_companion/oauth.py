"""Independent public-client OAuth; production calls only fixed OpenAI endpoints."""
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import secrets
import socket
import threading
import re
import time
import urllib.parse
import webbrowser
import jwt
from .security import AUTH, AUTHORIZE, TOKEN, RESOURCE, DISCOVERY, SCOPES, REQUIRED, SafeError, OAuthError, auth_url

JWKS = AUTH + "/.well-known/jwks.json"


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class Attempt:
    def __init__(self, host_id, redirect_uri, selected=None, force_consent=False):
        self.state = secrets.token_urlsafe(32)
        self.nonce = secrets.token_urlsafe(32)
        self.verifier = secrets.token_urlsafe(64)
        self.host_id = host_id
        self.redirect_uri = redirect_uri
        self.selected = selected
        self.force_consent = force_consent
        self.used = False
        self.created = time.monotonic()

    def url(self):
        query = {
            "client_id": self.selected["client_id"] if self.selected else "dynamic_agent_client",
            "ext_agent_host_id": self.host_id, "response_type": "code", "redirect_uri": self.redirect_uri,
            "scope": SCOPES, "resource": RESOURCE, "state": self.state, "nonce": self.nonce,
            "code_challenge_method": "S256", "code_challenge": b64(hashlib.sha256(self.verifier.encode()).digest()),
        }
        if self.force_consent:
            query["prompt"] = "consent"
        if not self.selected:
            query["agent_name_hint"] = "AI Tab Organizer"
        # Hints are optional. Do not put even an ID token in browser history or
        # process arguments; returning sign-ins show OpenAI's account selector.
        return AUTHORIZE + "?" + urllib.parse.urlencode(query)

    def callback(self, raw_path):
        if self.used or time.monotonic() - self.created > 180:
            raise SafeError("登录已过期或已处理，请重新开始。")
        parsed = urllib.parse.urlsplit(raw_path)
        if parsed.scheme or parsed.netloc or parsed.path != "/auth/callback" or parsed.fragment or len(raw_path) > 8192:
            raise SafeError("登录回调无效。")
        try:
            params = urllib.parse.parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True, max_num_fields=16)
        except ValueError:
            raise SafeError("登录回调无效。") from None
        if any(len(value) != 1 for value in params.values()):
            raise SafeError("登录回调包含重复字段。")
        state = params.get("state", [""])[0]
        if not state.isascii() or not hmac.compare_digest(state, self.state):
            raise SafeError("登录状态校验失败。")
        self.used = True
        if "error" in params:
            raise SafeError("登录未获授权，请在准备好时重新登录。")
        code = params.get("code", [""])[0]
        supplied = params.get("client_id", [""])[0]
        client_id = self.selected["client_id"] if self.selected else supplied
        if not code or len(code) > 4096 or not client_id or client_id == "dynamic_agent_client" or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", client_id):
            raise SafeError("注册回调不完整，请重新登录。")
        if self.selected and supplied and supplied != client_id:
            raise SafeError("返回的客户端与所选账户不符。")
        return {"grant_type": "authorization_code", "client_id": client_id, "code": code,
                "code_verifier": self.verifier, "redirect_uri": self.redirect_uri, "resource": RESOURCE}


class Validator:
    def __init__(self, http):
        self.http = http

    def verify(self, raw, client_id, nonce=None, subject=None, access_token=None, code=None):
        if not isinstance(raw, str) or len(raw) > 32000:
            raise SafeError("身份令牌无效。")
        try:
            header = jwt.get_unverified_header(raw)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or header.get("crit"):
                raise ValueError()
            # Fixed issuer/JWKS. Never use jku/x5u/iss from the unverified token.
            keys = self.http.json(JWKS).get("keys", [])
            candidates = [key for key in keys if key.get("kid") == header["kid"] and key.get("kty") == "RSA" and key.get("use", "sig") == "sig" and key.get("alg", "RS256") == "RS256"]
            if len(candidates) != 1:
                raise ValueError()
            key = jwt.PyJWK.from_dict(candidates[0], algorithm="RS256").key
            claims = jwt.decode(raw, key, algorithms=["RS256"], audience=client_id, issuer=AUTH,
                                leeway=30, options={"require": ["iss", "sub", "aud", "exp", "iat"]})
            aud = claims["aud"]
            if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != client_id:
                raise ValueError()
            if "azp" in claims and claims["azp"] != client_id:
                raise ValueError()
            if not isinstance(claims["sub"], str) or not claims["sub"]:
                raise ValueError()
            if nonce is not None and (not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce)):
                raise ValueError()
            if subject is not None and claims["sub"] != subject:
                raise ValueError()
            for claim, value in (("at_hash", access_token), ("c_hash", code)):
                if claim in claims:
                    expected = b64(hashlib.sha256(value.encode()).digest()[:16]) if isinstance(value, str) else ""
                    if not expected or not isinstance(claims[claim], str) or not hmac.compare_digest(claims[claim], expected):
                        raise ValueError()
            return claims
        except Exception:
            raise SafeError("OpenAI 身份签名、账户或登录随机值校验失败，未保存凭证。") from None


def token_record(data, client_id, claims, *, previous=None):
    previous = previous or {}
    access = data.get("access_token")
    refresh = data.get("refresh_token", previous.get("refresh_token"))
    if not isinstance(data.get("token_type"), str) or data["token_type"].lower() != "bearer" or not all(isinstance(v, str) and 0 < len(v) <= 32000 and not any(c.isspace() for c in v) for v in (access, refresh)):
        raise SafeError("服务未返回有效凭证，请重新登录。")
    expiry = data.get("expires_in")
    if type(expiry) is not int or not 0 < expiry <= 86400:
        raise SafeError("服务未返回有效凭证期限。")
    scope = data.get("scope")
    if "scope" in data and not isinstance(scope, str):
        raise SafeError("服务返回的授权范围格式无效。")
    scopes = scope.split() if isinstance(scope, str) else previous.get("scopes", [])
    if not REQUIRED.issubset(set(scopes)):
        raise SafeError("未授予 ChatGPT 计划调用权限，请重新授权；不会改用 API Key 计费。")
    return {"issuer": AUTH, "subject": claims["sub"], "email": claims.get("email", previous.get("email", "")),
            "client_id": client_id, "access_token": access, "refresh_token": refresh,
            "id_token": data.get("id_token", previous.get("id_token")), "scopes": scopes,
            "expires_at": time.time() + expiry}


def registration_key(record):
    value = "\0".join(record[field] for field in ("issuer", "client_id", "subject"))
    return hashlib.sha256(value.encode()).hexdigest()[:16]


class Session:
    """Every public operation is called with the cross-process Config lock held."""
    def __init__(self, vault, config, http):
        self.vault, self.config, self.http = vault, config, http
        self.validator = Validator(http)

    def selected(self, key=None):
        data = self.vault.load()
        key = key or data.get("active")
        record = data["accounts"].get(key)
        if not record:
            raise SafeError("请先在本机执行 ai-tab-companion login，独立授权 ChatGPT。")
        return data, key, record

    def access(self):
        data, key, record = self.selected()
        if not record.get("access_token") or not record.get("refresh_token"):
            raise SafeError("此账户已退出，请重新登录。")
        if not REQUIRED.issubset(set(record.get("scopes", []))):
            raise SafeError("此账户未授予 ChatGPT 计划调用权限。")
        if record.get("expires_at", 0) <= time.time() + 90:
            try:
                refreshed = self.http.json(TOKEN, form={"grant_type": "refresh_token", "client_id": record["client_id"], "refresh_token": record["refresh_token"], "resource": RESOURCE})
            except OAuthError:
                data["accounts"][key] = {k: record[k] for k in ("issuer", "client_id", "subject", "email") if k in record}
                self.vault.save(data)
                raise
            claims = {"sub": record["subject"], "email": record.get("email", "")}
            if refreshed.get("id_token"):
                claims = self.validator.verify(refreshed["id_token"], record["client_id"], subject=record["subject"], access_token=refreshed.get("access_token"))
            replacement = token_record(refreshed, record["client_id"], claims, previous=record)
            data["accounts"][key] = replacement
            # Persist the entire rotation before allowing any inference.
            self.vault.save(data)
            record = replacement
        return record["access_token"]

    def complete(self, attempt, form):
        if not attempt.selected or not attempt.selected.get("subject"):
            # Registration may exist even if the one-time exchange fails. Preserve
            # its issued ID for explicit --retry-registration, never as active identity.
            pending = self.vault.load()
            pending["pending_registration"] = {"client_id": form["client_id"]}
            self.vault.save(pending)
        response = self.http.json(TOKEN, form=form)
        claims = self.validator.verify(response.get("id_token"), form["client_id"], nonce=attempt.nonce,
                                       subject=attempt.selected.get("subject") if attempt.selected else None,
                                       access_token=response.get("access_token"), code=form.get("code"))
        record = token_record(response, form["client_id"], claims)
        data = self.vault.load()
        key = registration_key(record)
        existing = data["accounts"].get(key)
        if existing and any(existing.get(field) != record[field] for field in ("issuer", "client_id", "subject")):
            raise SafeError("账户标识冲突，已停止。")
        data["accounts"][key] = record
        data["active"] = key
        if data.get("pending_registration", {}).get("client_id") == record["client_id"]:
            data.pop("pending_registration", None)
        self.vault.save(data)
        return key

    def status(self):
        data = self.vault.load()
        record = data["accounts"].get(data.get("active"), {})
        return {"connected": bool(record.get("refresh_token")), "accountId": data.get("active") or "", "account": label(data.get("active", ""), record)}

    def logout(self, key=None):
        data, key, record = self.selected(key)
        confirmed = not bool(record.get("refresh_token"))
        try:
            if record.get("refresh_token"):
                for delay in (0, 1, 2):
                    if delay:
                        time.sleep(delay)
                    try:
                        discovery = self.http.json(DISCOVERY)
                        if discovery.get("issuer") != AUTH:
                            raise SafeError("身份服务配置不匹配。")
                        endpoint = auth_url(discovery["revocation_endpoint"])
                        with self.http.open(endpoint, form={"token": record["refresh_token"], "token_type_hint": "refresh_token", "client_id": record["client_id"]}) as response:
                            if response.status != 200:
                                raise SafeError("未确认远程撤销。")
                        confirmed = True
                        break
                    except (SafeError, KeyError):
                        continue
        except Exception:
            confirmed = False
        finally:
            # Local sign-out must run even if discovery is malformed or remote
            # revocation fails. A failed OS-store write still surfaces explicitly.
            data["accounts"][key] = {k: record[k] for k in ("issuer", "client_id", "subject", "email") if k in record}
            self.vault.save(data)
        return confirmed


def label(key, record):
    email = record.get("email", "")
    if not isinstance(email, str):
        email = ""
    email = "".join(c for c in email if c.isprintable())[:120]
    return f"{email or 'ChatGPT'} · {key[-6:]}" if key else ""


def login(session, key=None, *, retry_registration=False, force_consent=False, browser_open=webbrowser.open):
    selected = session.selected(key)[2] if key else None
    if retry_registration:
        if key:
            raise SafeError("不能同时重试注册和选择现有账户。")
        selected = session.vault.load().get("pending_registration")
        if not selected:
            raise SafeError("没有可重试的未完成注册。")
    received = {}
    attempt = None

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Do not log callback codes or authorization URLs.

        def do_GET(self):
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                self.send_error(400)
                return
            try:
                received["form"] = attempt.callback(self.path)
                code, message = 200, "Authorization received. Return to the companion terminal."
            except SafeError as exc:
                code, message = 400, "Authorization rejected. Return to the companion terminal."
                if attempt.used:
                    received["error"] = exc
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            try:
                self.wfile.write(message.encode())
            except (BrokenPipeError, ConnectionResetError):
                pass

    class LoopbackServer(HTTPServer):
        def __init__(self, *args):
            self.deadline = time.monotonic() + 180
            self.timers = {}
            super().__init__(*args)

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(2)
            # Socket timeout only bounds idle time. A separate wall-clock timer
            # also closes clients dripping partial headers a byte at a time.
            def expire():
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()
            timer = threading.Timer(max(0.01, min(5, self.deadline - time.monotonic())), expire)
            timer.daemon = True
            self.timers[connection] = timer
            timer.start()
            return connection, address

        def close_request(self, connection):
            timer = self.timers.pop(connection, None)
            if timer:
                timer.cancel()
            super().close_request(connection)

        def handle_error(self, *_):
            pass  # Never print request paths, codes, headers or tracebacks.

    # Bind loopback only before opening the browser; no LAN/CORS inference server.
    with LoopbackServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        attempt = Attempt(session.config.host_id(), f"http://127.0.0.1:{server.server_port}/auth/callback", selected, force_consent)
        if not browser_open(attempt.url(), new=1, autoraise=True):
            raise SafeError("无法打开系统浏览器，未开始授权。")
        while not received and time.monotonic() < server.deadline:
            server.handle_request()
    if "error" in received:
        raise received["error"]
    if "form" not in received:
        raise SafeError("登录已取消或超时，未改动当前账户。")
    return session.complete(attempt, received["form"])
