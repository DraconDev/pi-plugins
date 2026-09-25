#!/usr/bin/env python3
"""
Run a command inside a real pseudo-terminal and forward its exit status.

Used by `smoke:live` when the caller is not already attached to a terminal, so
the interactive gate can be run from CI or a contract check without weakening
it: the command still sees a real TTY, a real window size, and real key bytes.
"""
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("pty-run: a command is required\n")
        return 2
    rows = int(os.environ.get("PTY_ROWS", "40"))
    cols = int(os.environ.get("PTY_COLS", "110"))

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        os.execvp(argv[0], argv)
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    # Forward the child's output until its PTY master reports EOF. EOF means the
    # child is gone, so the loop must end and then reap it - not kill it.
    while True:
        try:
            readable, _, _ = select.select([fd], [], [], 0.1)
        except OSError:
            break
        if readable:
            try:
                chunk = os.read(fd, 1 << 16)
            except OSError:
                break
            if not chunk:
                break
            try:
                os.write(1, chunk)
            except OSError:
                break

    deadline = time.time() + 5
    while time.time() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        return 143


if __name__ == "__main__":
    sys.exit(main())
