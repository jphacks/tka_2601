#!/usr/bin/env python3
"""Run the bench page against the real firmware code, without a board.

A pseudo terminal stands in for the USB port. Behind it runs the firmware's real
console, call, audio and servo code, connected to the backend's real relay code
with its speech models replaced. The microphone, speaker and PWM are simulated,
so this checks the page and the protocol, not the hardware.
Run with: bash run.sh bench
"""
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import termios

BINARY = sys.argv.pop(1)
sys.path.insert(0, str(Path(__file__).parent))
from e2e_backend import Backend  # noqa: E402

HTTP_PORT = os.environ.get("XIAO_BENCH_PORT", "8767")


def raw(fd):
    attributes = termios.tcgetattr(fd)
    attributes[0] = attributes[1] = attributes[3] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attributes)


# Blocked so that sigwait receives them and the children below are always stopped.
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
with Backend() as backend:
    # The firmware owns the pty's master; the page's server opens its device path,
    # exactly as it opens the XIAO's /dev/cu.usbmodem port.
    master, slave = pty.openpty()
    raw(master)
    raw(slave)
    port_name = os.ttyname(slave)
    firmware = subprocess.Popen([BINARY, str(backend.port), "bench"], stdin=master, stdout=master, stderr=subprocess.DEVNULL)
    os.close(master)
    server = subprocess.Popen([sys.executable, str(Path(__file__).parents[1] / "calibration_ui/server.py"),
                               "--serial-port", port_name, "--http-port", HTTP_PORT,
                               "--history-file", str(Path(__file__).parents[1] / ".host-build/bench-history.json")])
    print(f"http://127.0.0.1:{HTTP_PORT}  (chime: kill -USR1 {firmware.pid})", flush=True)
    try:
        signal.sigwait({signal.SIGINT, signal.SIGTERM})
    finally:
        server.terminate()
        firmware.terminate()
