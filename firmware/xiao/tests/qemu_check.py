#!/usr/bin/env python3
"""Drive the real ESP32-S3 binary in QEMU over its serial console.

QEMU emulates the CPU, PSRAM, flash and LEDC registers. It has no Wi-Fi and no
I2S data, so the checks here stop short of the network and of real audio.
"""
import json
import re
import socket
import subprocess
import sys
import time

QEMU, FLASH = sys.argv[1:3]


class Board:
    def __init__(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.process = subprocess.Popen(
            [QEMU, "-nographic", "-machine", "esp32s3", "-m", "8M",
             "-global", "driver=ssi_psram,property=is_octal,value=true",
             "-drive", f"file={FLASH},if=mtd,format=raw",
             "-serial", f"tcp:127.0.0.1:{self.port},server,wait", "-monitor", "none"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while True:
            try:
                self.socket = socket.create_connection(("127.0.0.1", self.port), timeout=1)
                break
            except OSError:
                assert time.monotonic() < deadline, "QEMU did not open its serial port"
                time.sleep(0.1)
        self.socket.settimeout(0.2)
        self.text = ""
        self.mark = 0

    def pump(self):
        try:
            data = self.socket.recv(65536)
        except socket.timeout:
            return
        assert data, "serial port closed\n" + self.text[-2000:]
        self.text += data.decode("utf-8", "replace")

    def expect(self, pattern, seconds=30):
        deadline = time.monotonic() + seconds
        compiled = re.compile(pattern)
        while time.monotonic() < deadline:
            self.pump()
            match = compiled.search(self.text, self.mark)
            if match:
                self.mark = match.end()
                assert "Guru Meditation" not in self.text and "assert failed" not in self.text, self.text[-3000:]
                return match
        raise AssertionError(f"no {pattern!r} within {seconds}s\n--- recent output\n{self.text[-3000:]}")

    def send(self, line):
        self.mark = len(self.text)
        self.socket.sendall(line.encode() + b"\n")

    def ask(self, line, pattern, seconds=30):
        self.send(line)
        return self.expect(pattern, seconds)

    def cal(self, line, ok=True):
        match = self.ask(line, r"\[CAL\] (\{.*\})\r?\n")
        reply = json.loads(match[1])
        assert reply["ok"] is ok, (line, reply)
        return reply

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=10)
        self.socket.close()


def check(name):
    print("ok   " + name, flush=True)


first = Board()
try:
    first.expect(r"\[BOOT\] MONBAN XIAO ESP32S3")
    check("boots to setup(); flash mode, octal PSRAM and partition table accepted")
    first.expect(r"\[AUDIO\] Storage uninitialized")
    check("audio_store partition found, and not erased without being asked")
    first.expect(r"\[AUDIO\] PDM capture started")
    check("PDM driver accepts the pins and the 2.048 MHz clock configuration")
    first.expect(r"\[BOOT\] Network task running")
    check("all five tasks started")
    assert "PSRAM buffers unavailable" not in first.text and "could not start" not in first.text
    assert "I2S speaker initialization failed" not in first.text
    check("192 KB buffers allocated in PSRAM; I2S speaker driver accepts its configuration")
    first.ask("u", r"\[DIAG\] usb ok=1")
    check("serial console answers")

    reply = first.cal("@get")
    assert reply["settings_source"] == "defaults" and reply["pwm_active"] is False
    first.cal("@set c p 45", ok=False)  # begin_required
    first.cal("@begin")
    reply = first.cal("@set c p 45")
    assert reply["pwm_active"] is True and reply["commanded_angle"] == 45
    check("LEDC accepts 14 bit, 50 Hz on GPIO 7")
    first.expect(r"\[SERVO\] CALL released; PWM stopped", 15)
    for line in ("@time d 0", "@time c 200", "@time r 200", "@angles e 10 40", "@angles u 20 60"):
        first.cal(line)
    reply = first.cal("@save")
    assert reply["settings_source"] == "saved" and reply["saved"]["call_press"] == 45
    check("calibration saved to NVS")
    for key, name in (("1", "CALL"), ("2", "END"), ("3", "UNLOCK")):
        first.send(key)
        first.expect(rf"\[SERVO\] {name} press once")
        first.expect(rf"\[SERVO\] {name} released; PWM stopped", 15)
    check("three servo pins move, return and stop")

    reply = first.cal("@tune volume 55")
    assert reply["speaker_volume"] == 55
    first.cal("@tune margin 300", ok=False)
    check("runtime tuning saved and range-checked")

    match = first.ask("n", r"\[DIAG\] wifi (\{.*\})")
    assert json.loads(match[1])["connected"] is False
    first.ask("c", r"Wi-Fi, clock or API configuration not ready")
    first.ask("w", r"\[API WSS\] network_not_ready")
    first.ask("a", r"\[DIAG\] api_https network_not_ready")
    check("no network: calls and API checks refuse cleanly")

    first.ask("FORMAT_AUDIO_STORAGE", r"\[AUDIO\] Storage format complete", 120)
    check("2 MiB partition erased sector by sector and formatted")
    first.ask("e", r"\[SETUP\] Keep quiet for 2 seconds")
    first.ask("x", r"\[SETUP\] Registration cancelled")
    check("registration starts and cancels")

    match = first.ask("m", r"\[DIAG\] mic (\{.*\})", 10)
    mic = json.loads(match[1])
    assert mic["storage"] is True and mic["model"] is False
    print("     mic status without I2S data in QEMU:", mic["status"], flush=True)

    # QEMU delivers no I2S data, so these must fail with a reason instead of hanging.
    match = first.ask("t", r"\[DIAG\] speaker (ok=\d.*|busy)", 40)
    print("     speaker without I2S in QEMU:", match[1].strip(), flush=True)
    first.ask("u", r"\[DIAG\] usb ok=1")
    match = first.ask("l", r"\[DIAG\] loopback (ok=0 microphone_failed)", 40)
    print("     loopback without I2S in QEMU:", match[1].strip(), flush=True)
    first.ask("u", r"\[DIAG\] usb ok=1")
    check("speaker and loopback report the missing audio, and the board keeps answering")

    # Unprovisioned USB wiring stays at revision zero. Cloud replay/conflict
    # rules are exercised through the actual cloud apply API in host tests.
    reply = first.cal("@pusher 0 1 1 1")
    assert reply["pusher_revision"] == 0 and reply["enabled_mask"] == 1
    assert reply["call_start_pusher"] == reply["call_end_pusher"] == 1
    assert reply["pwm_active"] is False
    first.cal("@pusher 0 1 1 1")  # Idempotent retry.
    assert first.cal("@pusher 1 2 2 2", ok=False)["error"] == "invalid_pusher_config"
    first.cal("@pusher 0 3 1 1", ok=False)
    first.cal("@pusher 0 1 1 1 trailing", ok=False)
    assert first.cal("@test e", ok=False)["error"] == "pusher_disabled"
    check("local wiring saves at revision zero with no PWM; positive USB revisions and unused output are rejected")
    first.cal("@begin")
    reply = first.cal("@set c p 45")
    assert reply["pwm_active"] is True
    # Terminating QEMU now models power loss while a shared operation is marked.
    check("shared preview starts only after durable incomplete-operation marker")
finally:
    first.stop()

second = Board()
try:
    second.expect(r"\[AUDIO\] Storage ready; registered model not found")
    check("after power cycle: formatted store still valid")
    reply = second.cal("@get")
    assert reply["settings_source"] == "saved" and reply["call_press"] == 45 and reply["unlock_press"] == 60
    assert reply["pwm_active"] is False
    check("after power cycle: calibration restored, no PWM at boot")
    assert reply["pusher_revision"] == 0 and reply["enabled_mask"] == 1
    assert reply["manual_check_required"] is True
    assert second.cal("@test c", ok=False)["error"] == "manual_check_required"
    assert second.cal("@pusher 0 3 1 2", ok=False)["error"] == "manual_check_required"
    reply = second.cal("@confirm")
    assert reply["manual_check_required"] is False and reply["pwm_active"] is False
    reply = second.cal("@pusher 0 2 2 2")
    assert reply["pusher_revision"] == 0 and reply["enabled_mask"] == 2 and reply["call_start_pusher"] == reply["call_end_pusher"] == 2
    second.cal("@test e")
    second.expect(r"\[SERVO\] END released; PWM stopped", 15)
    assert second.cal("@get")["manual_check_required"] is True
    second.cal("@confirm")
    reply = second.cal("@pusher 0 3 2 1")
    assert reply["pusher_revision"] == 0 and reply["call_start_pusher"] == 2 and reply["call_end_pusher"] == 1
    assert reply["unlock_press"] == 60 and reply["pwm_active"] is False
    assert second.cal("@pusher 9 1 1 1", ok=False)["error"] == "invalid_pusher_config"
    check("shared power-loss interlock survives boot; confirmation, physical-2 sharing and swapped mapping work")
    assert second.cal("@tune get")["speaker_volume"] == 55
    check("after power cycle: tuning restored")
finally:
    second.stop()
print("PASS: real ESP32-S3 binary in QEMU")
