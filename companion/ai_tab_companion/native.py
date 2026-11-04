"""Bounded Chrome native messaging. stdout is protocol only, never diagnostics."""
import json
import re
import struct
from .security import SafeError, strict_json

HOST = "com.ai_tab_organizer.siwc"
MAX_MESSAGE = 128 * 1024


def origin_for(extension_id):
    if not isinstance(extension_id, str) or not re.fullmatch(r"[a-p]{32}", extension_id):
        raise SafeError("扩展 ID 无效。")
    return "chrome-extension://" + extension_id + "/"


def verify_origin(origin, config):
    extension_id = config.read().get("extension_id")
    if origin != origin_for(extension_id):
        raise SafeError("此扩展未获 companion 授权。")


def read_exact(stream, length):
    result = b""
    while len(result) < length:
        chunk = stream.read(length - len(result))
        if not chunk:
            raise SafeError("原生消息被截断。")
        result += chunk
    return result


def read_message(stream):
    first = stream.read(4)
    if not first:
        return None
    if len(first) != 4:
        first += read_exact(stream, 4 - len(first))
    size = struct.unpack("=I", first)[0]
    if not 0 < size <= MAX_MESSAGE:
        raise SafeError("原生消息过大或为空。")
    message = strict_json(read_exact(stream, size))
    if not isinstance(message, dict):
        raise SafeError("原生消息格式无效。")
    return message


def write_message(stream, message):
    raw = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
    if len(raw) > MAX_MESSAGE:
        raise SafeError("原生响应过大。")
    stream.write(struct.pack("=I", len(raw)) + raw)
    stream.flush()


def handle(message, session, inference):
    request_id = message.get("id")
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request_id):
        raise SafeError("原生请求标识无效。")
    allowed = {"id", "type"}
    kind = message.get("type")
    if kind == "classify":
        allowed |= {"accountId", "model", "categories", "tabs"}
    if set(message) != allowed:
        raise SafeError("原生请求包含未许可字段。")
    if kind == "status":
        return session.status()
    if kind == "models":
        return inference.models()
    if kind == "classify":
        return inference.classify({key: message[key] for key in ("accountId", "model", "categories", "tabs")})
    raise SafeError("不支持的原生操作。登录和退出请在本机终端完成。")


def serve(origin, config, session, inference, input_stream, output_stream):
    verify_origin(origin, config)
    while True:
        message = read_message(input_stream)
        if message is None:
            return
        request_id = message.get("id")
        safe_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request_id) else None
        try:
            with config.lock():
                verify_origin(origin, config)
                inference.http.begin_request()
                result = handle(message, session, inference)
            response = {"id": safe_id, "ok": True, "result": result}
        except SafeError as exc:
            response = {"id": safe_id, "ok": False, "error": str(exc)}
        except Exception:
            response = {"id": safe_id, "ok": False, "error": "companion 无法完成请求，未改动标签。请检查本机安装或重新登录。"}
        write_message(output_stream, response)
