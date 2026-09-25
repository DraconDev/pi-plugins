#!/usr/bin/env python3
"""
Real-TTY harness for the live smoke.

The interactive part runs in a *real* pseudo-terminal so pi-tui sees
stdin.isTTY/stdout.isTTY, terminal size, and raw keypresses. A non-zero exit
from the driver is a failed smoke; the driver itself refuses to run without a
TTY, so this script can never manufacture a pass.
"""
import argparse
import json
import os
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import time
import fcntl

KEYS = {
    "down": b"\x1b[B",
    "up": b"\x1b[A",
    "enter": b"\r",
    "collapse": b"\x1d",
    "editor": b"e",
    "ctrl_c": b"\x03",
    "esc": b"\x1b",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=110)
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()

    if os.path.exists(args.out):
        os.unlink(args.out)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(args.cols)
        os.environ["LINES"] = str(args.rows)
        os.environ.pop("NODE_OPTIONS", None)
        node = shutil.which("node") or "node"
        os.execvp(node, [node, args.driver, *sys.argv[1:]])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    transcript = bytearray()
    deadline = time.time() + args.timeout
    editor_pending = False
    steps = ["down", "enter", "collapse", "collapse", "up", "enter"]
    step_index = 0
    editor_sent = False

    while time.time() < deadline:
        remaining = deadline - time.time()
        readable, _, _ = select.select([fd], [], [], min(0.4, max(0.05, remaining)))
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            transcript += chunk
            if not editor_pending and b"Launching external editor" in bytes(transcript[-4000:]):
                editor_pending = True
        if os.path.exists(args.out):
            # Evidence written means the driver finished its walk.
            break
        if editor_pending and not editor_sent:
            time.sleep(0.6)
            # Exit the configured editor non-interactively, then confirm.
            os.write(fd, KEYS["ctrl_c"])
            time.sleep(0.3)
            os.write(fd, b"\x1b")  # nano/vim leave prompt escape
            time.sleep(0.4)
            editor_sent = True
            continue
        if step_index < len(steps):
            os.write(fd, KEYS[steps[step_index]])
            step_index += 1
            time.sleep(0.45)
        else:
            time.sleep(0.2)

    finished = os.path.exists(args.out)
    status, code = None, None
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline2 = time.time() + 5
    while time.time() < deadline2:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            code = os.waitstatus_to_exitcode(status)
            break
        time.sleep(0.1)
    else:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        code = -1

    if not finished:
        sys.stderr.write(json.dumps({
            "status": "failed",
            "reason": "driver never wrote evidence (no TTY pass is possible)",
            "exitCode": code,
            "transcriptTail": bytes(transcript[-1200:]).decode("utf8", "replace"),
        }) + "\n")
        return 2

    evidence = json.load(open(args.out))
    evidence["pty"] = {"rows": args.rows, "cols": args.cols, "exitCode": code, "usedPseudoTerminal": True}
    with open(args.out, "w") as handle:
        json.dump(evidence, handle, indent=2)
    sys.stdout.write(json.dumps({
        "status": evidence.get("status"),
        "steps": len(evidence.get("steps", [])),
        "assertions": evidence.get("assertions"),
        "errors": evidence.get("errors", []),
    }) + "\n")
    return 0 if evidence.get("status") == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
