"""Local reference receiver. Put an authenticated HTTPS reverse proxy in front for a board.

Contract: PUT /v1/doorbell/recordings/<32 hex ID>, Bearer token, audio/wav.
ACK (200/201, plain ID) is emitted only after durable file storage. No AI calls.
"""
import argparse
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import struct
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_WAV_BYTES = 44 + 16000 * 2 * 6
ID_PATTERN = re.compile(r"/v1/doorbell/recordings/([0-9a-f]{32})\Z")


def validate_wav(data):
    if not 44 < len(data) <= MAX_WAV_BYTES:
        raise ValueError("invalid WAV size")
    if data[:4] != b"RIFF" or data[8:16] != b"WAVEfmt " or data[36:40] != b"data":
        raise ValueError("expected canonical PCM WAV")
    riff_size, = struct.unpack_from("<I", data, 4)
    fmt_size, fmt, channels, rate, byte_rate, block_align, bits = struct.unpack_from("<IHHIIHH", data, 16)
    pcm_size, = struct.unpack_from("<I", data, 40)
    if (fmt_size, fmt, channels, rate, byte_rate, block_align, bits) != (16, 1, 1, 16000, 32000, 2, 16):
        raise ValueError("expected 16kHz mono 16-bit PCM")
    if riff_size != len(data) - 8 or pcm_size != len(data) - 44 or pcm_size % 2:
        raise ValueError("inconsistent WAV lengths")


class RecordingStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def _atomic_write(self, target, content):
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".upload-", delete=False) as stream:
                temp = Path(stream.name)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, target)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    def save(self, event_id, data, score=None):
        if not re.fullmatch(r"[0-9a-f]{32}", event_id):
            raise ValueError("invalid event ID")
        validate_wav(data)
        with self.lock:
            target = self.root / f"{event_id}.wav"
            existed = target.exists()
            if existed and target.read_bytes() != data:
                raise FileExistsError("event ID already contains different audio")
            if not existed:
                self._atomic_write(target, data)
            metadata = self.root / f"{event_id}.json"
            if not metadata.exists():
                self._atomic_write(metadata, json.dumps({
                    "id": event_id, "received_at_unix": time.time(),
                    "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                    "match_distance": score,
                }, allow_nan=False).encode())
            # Persist directory entries too, including recovery from a prior unacknowledged write.
            fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            return not existed


def make_handler(store, token):
    if not token:
        raise ValueError("a non-empty receiver token is required")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log Authorization, bodies, or visitor audio.

        def reply(self, status, body):
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_PUT(self):
            self.connection.settimeout(10)
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                       ("Bearer " + token).encode()):
                self.reply(401, "unauthorized\n"); return
            match = ID_PATTERN.fullmatch(self.path)
            if not match:
                self.reply(404, "not found\n"); return
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                self.reply(400, "one Content-Length is required\n"); return
            length = int(lengths[0])
            if not 44 < length <= MAX_WAV_BYTES:
                self.reply(413, "invalid audio size\n"); return
            if self.headers.get("Content-Type") != "audio/wav":
                self.reply(415, "expected audio/wav\n"); return
            try:
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("incomplete upload")
                score = float(self.headers["X-Audio-Match-Score"]) if self.headers.get("X-Audio-Match-Score") else None
                if score is not None and not math.isfinite(score):
                    raise ValueError("invalid match score")
                created = store.save(match[1], data, score)
            except FileExistsError:
                self.reply(409, "ID conflict\n"); return
            except (ValueError, TimeoutError):
                self.reply(400, "invalid or incomplete audio\n"); return
            except OSError:
                self.reply(503, "storage unavailable\n"); return
            self.reply(201 if created else 200, match[1] + "\n")

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--directory", default="recordings")
    args = parser.parse_args()
    token = os.environ.get("AUDIO_RECEIVER_TOKEN", "")
    if not token:
        parser.error("set AUDIO_RECEIVER_TOKEN locally; do not paste it into chat")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(RecordingStore(args.directory), token))
    print(f"Reference receiver on 127.0.0.1:{args.port}. External board access requires HTTPS termination.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
