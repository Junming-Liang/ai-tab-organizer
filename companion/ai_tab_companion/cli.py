"""User-invoked CLI. OAuth and OS installation are never started by the extension."""
import argparse
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import uuid
from .inference import Inference
from .native import HOST, origin_for, serve, verify_origin
from .oauth import Session, label, login
from .security import Http, SafeError
from .storage import Config, Vault


def write_private(path, content, mode=0o600):
    temp = path.with_name("." + path.name + "-" + uuid.uuid4().hex)
    try:
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def install_host(config, extension_id, *, destination=None):
    origin = origin_for(extension_id)
    # Fixed package entry point, no credential arguments, arbitrary command, or URL.
    launcher = config.home / "native-host"
    script = "#!/bin/sh\nexec " + shlex.quote(sys.executable) + " -I -m ai_tab_companion.cli --native \"$@\"\n"
    if destination is None:
        relative = "Library/Application Support/Google/Chrome/NativeMessagingHosts" if sys.platform == "darwin" else ".config/google-chrome/NativeMessagingHosts"
        destination = Path.home() / relative
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = destination.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SafeError("Chrome 原生主机目录所有者或写权限不安全。")
    manifest = {"name": HOST, "description": "AI Tab Organizer independent SIWC companion", "path": str(launcher), "type": "stdio", "allowed_origins": [origin]}
    write_private(launcher, script, 0o700)
    data = config.read()
    data["extension_id"] = extension_id
    config.write(data)
    path = destination / (HOST + ".json")
    write_private(path, json.dumps(manifest, indent=2) + "\n")
    return path


def run():
    if len(sys.argv) >= 2 and sys.argv[1] == "--native":
        if len(sys.argv) != 3:
            raise SafeError("缺少可信扩展来源。")
        config = Config()
        verify_origin(sys.argv[2], config)  # Before even opening the credential store.
        http = Http()
        session = Session(Vault(), config, http)
        serve(sys.argv[2], config, session, Inference(session, http), sys.stdin.buffer, sys.stdout.buffer)
        return
    parser = argparse.ArgumentParser(description="Independent ChatGPT plan companion. Never starts or reads Codex. macOS/Linux experimental.")
    commands = parser.add_subparsers(dest="command", required=True)
    signin = commands.add_parser("login", help="Open the system browser for a new independent OAuth grant")
    signin.add_argument("--consent", action="store_true", help="Explicitly request the OpenAI consent screen again")
    signin.add_argument("--retry-registration", action="store_true", help="Reuse the issued client ID from an incomplete first registration")
    signin.add_argument("--account", help="Reauthorize this saved account ID; otherwise register a new account/workspace")
    commands.add_parser("accounts", help="List independently registered accounts; no tokens")
    choose = commands.add_parser("use", help="Select an already-authorized account")
    choose.add_argument("account")
    signout = commands.add_parser("logout", help="Revoke and clear the selected account tokens")
    signout.add_argument("--account")
    commands.add_parser("status", help="Read local connection status without inference")
    install = commands.add_parser("install-host", help="Authorize one extension ID via a Chrome native-host manifest")
    install.add_argument("--extension-id", required=True)
    install.add_argument("--confirm-install", action="store_true", help="Confirm persistent access for this one extension ID")
    args = parser.parse_args()
    config = Config()
    with config.lock():
        if args.command == "install-host":
            if not args.confirm_install:
                raise SafeError("安装将允许指定扩展持续调用本机 companion。确认后请添加 --confirm-install。")
            path = install_host(config, args.extension_id)
            print(f"Installed for one extension only: {path}")
            return
        http = Http()
        vault = Vault()
        session = Session(vault, config, http)
        if args.command == "login":
            print("Continue with ChatGPT: opening the system browser for independent authorization.")
            print("This uses shared ChatGPT plan capacity. It can affect remaining capacity in other apps. No Codex sessions or credentials are accessed.")
            key = login(session, args.account, retry_registration=args.retry_registration, force_consent=args.consent)
            print("Authorized account:", key)
        elif args.command == "accounts":
            data = vault.load()
            for key, record in data["accounts"].items():
                print("*" if key == data.get("active") else " ", key, label(key, record), "connected" if record.get("refresh_token") else "signed out")
        elif args.command == "use":
            data, key, record = session.selected(args.account)
            if not record.get("refresh_token"):
                raise SafeError("所选账户已退出，请 login --account 重新授权。")
            data["active"] = key
            vault.save(data)
            print("Active account:", key, "Refresh the extension's model list before use.")
        elif args.command == "logout":
            confirmed = session.logout(args.account)
            print("Signed out locally. Remote session revoked." if confirmed else "Signed out locally; remote revocation was NOT confirmed. Disconnect the app in ChatGPT Settings: https://chatgpt.com/settings/usage")
        else:
            print(json.dumps(session.status(), ensure_ascii=False))


def main():
    try:
        run()
    except KeyboardInterrupt:
        print("Cancelled. No classification was applied.", file=sys.stderr)
        raise SystemExit(130) from None
    except SafeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        # Do not leak tokens, callback parameters, provider bodies or tracebacks.
        print("companion could not complete the operation. Check secure storage, network and installation.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
