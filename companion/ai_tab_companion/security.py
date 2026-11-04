"""Small, fail-closed HTTP and parsing boundary. No response bodies in errors."""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
AUTHORIZE = AUTH + "/api/accounts/authorize"
TOKEN = AUTH + "/api/accounts/oauth/token"
DISCOVERY = AUTH + "/.well-known/openid-configuration"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REQUIRED = {"chatgpt.tokens.use.direct", "resource.invoke"}


class SafeError(Exception):
    """Only fixed, non-secret strings may cross the UI boundary."""


class OAuthError(SafeError):
    def __init__(self, code):
        self.code = code
        super().__init__("OpenAI 登录凭证已失效，请重新授权原账户。")



def strict_json(raw):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise SafeError("收到含重复字段的数据，已拒绝。")
            obj[key] = value
        return obj
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, TypeError) as exc:
        raise SafeError("收到无效 JSON，已拒绝。") from exc


def auth_url(url):
    if not isinstance(url, str):
        raise SafeError("身份服务端点格式无效。")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        raise SafeError("身份服务端点格式无效。") from None
    if (parsed.scheme, parsed.netloc) != ("https", "auth.openai.com") or parsed.fragment or parsed.username or parsed.password:
        raise SafeError("身份服务端点不受信任。")
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SafeError("服务返回了重定向，已停止以保护凭证。")


class DeadlineResponse:
    def __init__(self, response, deadline):
        self.response, self.deadline = response, deadline
        self.headers, self.status = response.headers, response.status

    def read1(self, size):
        if time.monotonic() >= self.deadline:
            raise SafeError("OpenAI 请求超时，未改动标签；请查看用量后再决定是否重试。")
        result = self.response.read1(size)
        if time.monotonic() >= self.deadline:
            raise SafeError("OpenAI 请求超时，未改动标签；请查看用量后再决定是否重试。")
        return result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.response.close()


class Http:
    def __init__(self):
        # Never inherit arbitrary proxy URLs or forward credentials on redirects.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.deadline = None

    def begin_request(self, seconds=50):
        self.deadline = time.monotonic() + seconds

    def open(self, url, *, form=None, body=None, token=None):
        if url.startswith(AUTH + "/"):
            auth_url(url)
        elif url not in (RESOURCE + "/models", RESOURCE + "/responses"):
            raise SafeError("不支持的服务端点。")
        headers = {"Accept": "application/json", "User-Agent": "AI-Tab-Organizer-Companion/0.2.0"}
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
            headers["Accept"] = "text/event-stream"
        if token:
            if not isinstance(token, str) or len(token) > 32000 or any(c.isspace() for c in token):
                raise SafeError("已保存凭证无效，请重新登录。")
            headers["Authorization"] = "Bearer " + token
        try:
            deadline = self.deadline or (time.monotonic() + 50)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SafeError("OpenAI 请求超时，未改动标签；不会自动重试推理。")
            response = self.opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=min(10, remaining))
            if time.monotonic() >= deadline:
                response.close()
                raise SafeError("OpenAI 请求超时，未改动标签；不会自动重试推理。")
            return DeadlineResponse(response, deadline)
        except urllib.error.HTTPError as exc:
            # Only a bounded, explicit machine-code allowlist can leave this block.
            # Descriptions, bodies, URLs, headers and tokens never cross the UI.
            if url == TOKEN:
                try:
                    detail = strict_json(bounded_read(exc, 8192, seconds=5))
                    code = detail.get("error") if isinstance(detail, dict) else None
                    if isinstance(code, dict):
                        code = code.get("code")
                except Exception:
                    code = None
                if isinstance(code, str) and code in {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"}:
                    raise OAuthError(code) from None
            if exc.code in (401, 403):
                raise SafeError("OpenAI 拒绝访问，请检查授权、账户资格或重新登录。") from None
            if exc.code == 429:
                raise SafeError("OpenAI 当前额度或速率受限，请稍后再试并查看 ChatGPT 用量设置。") from None
            raise SafeError(f"OpenAI 请求失败（HTTP {exc.code}），未更改标签。") from None
        except (OSError, urllib.error.URLError) as exc:
            raise SafeError("无法连接 OpenAI。未重试付费推理，请检查网络。") from None

    def json(self, url, **kwargs):
        with self.open(url, **kwargs) as response:
            raw = bounded_read(response, 512_000)
        result = strict_json(raw)
        if not isinstance(result, dict):
            raise SafeError("服务返回格式无效。")
        return result


def bounded_read(response, limit, seconds=30):
    end = time.monotonic() + seconds
    parts = []
    total = 0
    while True:
        part = response.read1(min(8192, limit + 1 - total))
        if time.monotonic() > end:
            raise SafeError("服务响应超时。")
        if not part:
            break
        total += len(part)
        if total > limit:
            raise SafeError("服务响应过大。")
        parts.append(part)
    return b"".join(parts)
