"""OS credential storage only. No plaintext token fallback or Codex access."""
import contextlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid
from .security import SafeError, strict_json

SERVICE = "ai-tab-organizer.siwc"
ACCOUNT = "independent-accounts-v1"


def default_home():
    return Path.home() / ("Library/Application Support/AI Tab Organizer" if sys.platform == "darwin" else ".config/ai-tab-organizer")


def private_dir(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SafeError("companion 配置目录必须属于当前用户且权限为 0700。")
    return path


class Config:
    def __init__(self, home=None):
        if sys.platform not in ("darwin", "linux"):
            raise SafeError("实验版 companion 仅支持 macOS / Linux，Windows 尚未实现。")
        self.home = private_dir(home or default_home())
        self.path = self.home / "host.json"

    def read(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
                raise SafeError("companion 配置文件权限或大小无效。")
            result = strict_json(handle.read())
        if not isinstance(result, dict):
            raise SafeError("companion 配置无效。")
        return result

    def write(self, data):
        temp = self.home / (".host-" + uuid.uuid4().hex)
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(data, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self.path)
        finally:
            temp.unlink(missing_ok=True)

    def host_id(self):
        data = self.read()
        if "host_id" not in data:
            data["host_id"] = "urn:uuid:" + str(uuid.uuid4())
            self.write(data)
        return data["host_id"]

    @contextlib.contextmanager
    def lock(self):
        import fcntl
        fd = os.open(self.home / "process.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
                raise SafeError("companion 锁文件权限无效。")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SafeError("companion 正在处理另一项请求，请稍后重试。") from None
            yield
        finally:
            os.close(fd)


class Vault:
    def __init__(self):
        try:
            # Explicit platform backend: never select a plugin, plaintext fallback,
            # keyrings.alt, environment-selected backend, or chained backend.
            if sys.platform == "darwin":
                from keyring.backends.macOS import Keyring
            elif sys.platform == "linux":
                from keyring.backends.SecretService import Keyring
            else:
                raise SafeError("系统安全凭证库暂不支持此平台。")
            self.backend = Keyring()
            if self.backend.priority <= 0:
                raise SafeError("系统安全凭证库不可用。")
        except Exception:
            raise SafeError("系统钥匙串不可用或未解锁，已停止；不会回退明文保存。") from None

    def load(self):
        try:
            raw = self.backend.get_password(SERVICE, ACCOUNT)
            data = strict_json(raw) if raw else {"accounts": {}, "active": None}
            if not isinstance(data, dict) or not isinstance(data.get("accounts"), dict):
                raise ValueError()
            return data
        except Exception:
            raise SafeError("无法读取系统钥匙串，请确认已解锁。") from None

    def save(self, data):
        try:
            # All rotated tokens and metadata are replaced as one credential item.
            self.backend.set_password(SERVICE, ACCOUNT, json.dumps(data, separators=(",", ":")))
        except Exception:
            raise SafeError("系统钥匙串保存失败，已停止请求。请重新登录。") from None
