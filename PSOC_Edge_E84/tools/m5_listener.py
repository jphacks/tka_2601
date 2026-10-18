#!/usr/bin/env python3
"""Print authenticated, deduplicated chime events. Never operate an actuator."""
import argparse
from collections import OrderedDict
import hmac
import json
import math
from pathlib import Path
import re
import socket
import time


def parse_event(packet, token):
    if len(packet) > 512 or not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("Invalid packet or receiver configuration")
    try:
        event = json.loads(packet)
    except (ValueError, UnicodeError):
        raise ValueError("Invalid JSON") from None
    if not isinstance(event, dict) or type(event.get("v")) is not int or event["v"] != 1 or event.get("type") != "chime":
        raise ValueError("Unsupported event")
    supplied = event.get("token")
    if not isinstance(supplied, str) or not supplied.isascii() or not hmac.compare_digest(supplied, token):
        raise ValueError("Authentication failed")
    event_id = event.get("event_id")
    score = event.get("score")
    if not isinstance(event_id, str) or not re.fullmatch(r"[0-9a-f]{32}", event_id):
        raise ValueError("Invalid event ID")
    try:
        finite = type(score) in (int, float) and math.isfinite(score)
    except OverflowError:
        finite = False
    if not finite or (score < 0 and score != -1):
        raise ValueError("Invalid match score")
    return {"v": 1, "type": "chime", "event_id": event_id, "score": score}


class Deduplicator:
    def __init__(self, capacity=1024, ttl=600.0):
        self.capacity, self.ttl = capacity, ttl
        self.seen = OrderedDict()

    def accept(self, event_id, now):
        while self.seen and now - next(iter(self.seen.values())) >= self.ttl:
            self.seen.popitem(last=False)
        if event_id in self.seen:
            return False
        self.seen[event_id] = now
        if len(self.seen) > self.capacity:
            self.seen.popitem(last=False)
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[1] / ".m5-link.json")
    parser.add_argument("--bind", default="0.0.0.0")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        token, port = config["token"], config["port"]
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token) or type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        parser.error("Valid private configuration is required. Run configure_m5.py first.")
    recent = Deduplicator()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
        listener.bind((args.bind, port))
        print(f"Listening on {args.bind}:{port}; prints events only, no actuator and no ACK.")
        while True:
            packet, source = listener.recvfrom(513)
            try:
                event = parse_event(packet, token)
            except ValueError:
                continue
            if recent.accept(event["event_id"], time.monotonic()):
                print(json.dumps({**event, "source": source[0]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
