#!/usr/bin/env python3
"""
Real-TTY harness for the live smoke.

The interactive driver runs inside a *real* pseudo-terminal so pi-tui sees
stdin.isTTY/stdout.isTTY, a real window size, and real key bytes. The driver
decides what to press (it writes a key queue file) and this harness supplies
those bytes through the PTY master. Nothing here can manufacture a pass: the
driver refuses to run without a TTY, and the evidence it writes is required.
"""
import argparse
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl
import shutil

SPECIAL = {
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "right": b"\x1b[C",
    "left": b"\x1b[D",
    "enter": b"\r",
    "tab": b"\t",
    "space": b" ",
    "escape": b"\x1b",
    "ctrl+[": b"\x1b",
    "ctrl+]": b"\x1d",
    "ctrl+c": b"\x03",
    "ctrl+x": b"\x18",
    "ctrl+k": b"\x0b",
    "alt+q": b"\x1bq",
}


CONTROL = {chr(code): bytes([code]) for code in list(range(1, 27)) + [127]}
for _name, _byte in list(SPECIAL.items()):
    CONTROL[_name] = _byte
CONTROL["escape"] = b"\x1b"
CONTROL["enter"] = b"\r"
CONTROL["space"] = b" "


def encode(token: str) -> bytes:
    """Keybinding ids ("ctrl+g") become real control bytes, names become their
    escape sequence, and anything else is typed literally."""
    if token in CONTROL:
        return CONTROL[token]
    if token.startswith("literal:"):
        return token[len("literal:"):].encode()
    if token.startswith("ctrl+") and len(token) == 6:
        return CONTROL.get(token[-1].lower(), token.encode())
    if token in SPECIAL:
        return SPECIAL[token]
    return token.encode()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--keys-file", default=None)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=110)
    parser.add_argument("--timeout", type=float, default=120.0)
    takes_value = {"--driver", "--out", "--keys-file", "--rows", "--cols", "--timeout"}
    argv = sys.argv[1:]
    known, rest = [], []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in takes_value:
            known += [token, argv[index + 1]]
            index += 2
            continue
        if token.startswith("--") and "=" in token and token.split("=")[0] in takes_value:
            known.append(token)
            index += 1
            continue
        rest = argv[index:]
        break
    args = parser.parse_args(known)

    keys_file = args.keys_file or (os.path.splitext(args.out)[0] + "-keys.json")
    for path in (args.out, keys_file):
        if os.path.exists(path):
            os.unlink(path)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("NODE_OPTIONS", None)
        node = shutil.which("node") or "node"
        os.execvp(node, [node, args.driver, *rest, f"--keys={keys_file}", f"--out={args.out}"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    transcript = bytearray()
    deadline = time.time() + args.timeout
    sent_keys = set()
    harness_log = []
    editor_active = False
    editor_finished_at = None
    editor_escape_sent = False

    while time.time() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.15)
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            transcript += chunk
        if os.path.exists(args.out):
            try:
                evidence = json.load(open(args.out))
            except (ValueError, OSError):
                evidence = {}
            if evidence.get("status") in {"passed", "failed"}:
                break
        # Drive the real editor: quit it and return control to the TUI.
        if editor_active and not editor_escape_sent and b"micro" in bytes(transcript[-2000:]).lower():
            time.sleep(1.2)
            os.write(fd, SPECIAL["ctrl+q"])
            time.sleep(0.4)
            os.write(fd, SPECIAL["enter"])
            editor_escape_sent = True
            editor_finished_at = time.time()
        if os.path.exists(keys_file):
            try:
                queue = json.load(open(keys_file)).get("queued", [])
            except (ValueError, OSError):
                queue = []
            fresh = [item for item in queue if item.get("id") not in sent_keys]
            if fresh:
                for item in fresh:
                    os.write(fd, encode(item["data"]))
                    sent_keys.add(item.get("id"))
                    harness_log.append({"sent": item.get("id"), "data": item.get("data"), "why": item.get("why")})
                    time.sleep(0.4)
        time.sleep(0.05)

    finished = os.path.exists(args.out)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    code = None
    deadline2 = time.time() + 6
    while time.time() < deadline2:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            code = os.waitstatus_to_exitcode(status)
            break
        time.sleep(0.1)
    if code is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        code = -1

    if not finished:
        sys.stderr.write(json.dumps({
            "harnessLog": harness_log,
            "status": "failed",
            "reason": "the driver never wrote evidence, so no live pass is possible",
            "exitCode": code,
            "transcriptTail": bytes(transcript[-1500:]).decode("utf8", "replace"),
        }) + "\n")
        return 2

    evidence = json.load(open(args.out))
    evidence["pty"] = {"rows": args.rows, "cols": args.cols, "exitCode": code, "usedPseudoTerminal": True}
    evidence["harnessLog"] = harness_log
    with open(args.out, "w") as handle:
        json.dump(evidence, handle, indent=2)
    sys.stdout.write(json.dumps({
        "status": evidence.get("status"),
        "steps": len(evidence.get("steps", [])),
        "assertions": evidence.get("assertions"),
        "errors": evidence.get("errors", {}),
    }) + "\n")
    return 0 if evidence.get("status") == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
