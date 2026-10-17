# Device voice protocol v1

This document describes the **E84 ↔ M5 TCP protocol**, at the configured UDP port
+ 1. DVS1 remains the local playback/servo protocol. The cloud connection uses
authenticated `/api/relay` protocol version 2: JSON control messages and raw PCM,
without a DVS1 header. E84 translates between these two transports. See the
[backend README](../../backend/voice-agent/README.md) for the WebSocket contract.

Header: 24 bytes, network byte order: magic `DVS1` (4), type (u8), flags (u8,
zero unless specified), reserved (u16 zero), session (u32 nonzero), turn (u32),
sequence (u32), payload length (u32, maximum 1280). PCM is signed little-endian
16-bit mono, 16000 Hz. AUDIO payloads are 2..640 bytes, even. Input audio uses
640-byte frames. Session comes from the E84 boot nonce and call counter. Turn 0
is the greeting; visitor turns begin at 1 and increase without reuse.

| Value | Name | Meaning |
|---|---|---|
| 1 | HELLO | First packet. M5 payload is pairing token UTF-8. turn/seq 0. |
| 2 | READY | Authenticated, prepared; no payload. |
| 3 | CALL_START | E84 requests servo call-button operation; to server only after M5 CALL_STARTED. |
| 4 | CALL_STARTED | M5 completed call-button operation. |
| 5 | INPUT_START | E84 starts next visitor turn; no payload. |
| 6 | INPUT_AUDIO | PCM; seq starts at 0 and increments per packet. |
| 7 | INPUT_END | seq is total input frame count; flags 0 silence, 1 duration cap. No payload. |
| 8 | OUTPUT_START | Begin response for current turn (0 for greeting); no payload. |
| 9 | OUTPUT_AUDIO | PCM; seq starts at 0. |
| 10 | OUTPUT_END | seq is total output packet count; flags bit 0 means end call after playback. |
| 11 | PLAYBACK_DONE | M5 finished all output and hardware drain. seq matches OUTPUT_END. E84 forwards to server. |
| 12 | LISTEN | Server authorizes recording; turn is next visitor turn. |
| 13 | CALL_END | End session/press end button, after playback. |
| 14 | CALL_ENDED | M5 completed end-button operation. |
| 15 | CANCEL | Server: abort session/model work. M5: stop playback, return an in-progress servo, press end if a call may have started, then reply CALL_ENDED on the same connection. No payload. |
| 16 | ERROR | Terminal error; bounded non-secret UTF-8 payload. |
| 17 | PING | Keepalive; sequence echoed. |
| 18 | PONG | Keepalive reply. |
| 19 | NO_REPLY | Current input processed without speech; followed by LISTEN or CALL_END. |
| 20 | AUDIO_ACK | M5 accepted output into bounded playback queue. seq is cumulative packet count. Forwarded by E84 to server. |

All unspecified flags, lengths, sequence values and reserved fields must be
validated. Unexpected state/session/turn is an error. No duplicate PCM accepted.
Control packets have sequence 0 except where noted. M5 servo actions are once
per session and operation; retries return the existing result without re-actuation.

Server allows at most 10 unacknowledged OUTPUT_AUDIO packets (200ms). M5 only
ACKs after queue acceptance and does not read another packet while its bounded
queue is full. E84 relays ACKs while streaming. OUTPUT_END follows all PCM on the
same ordered transport. PLAYBACK_DONE requires END plus queue and speaker drain;
network EOF, buffer underrun, or generation completion never count as playback done.
An output shorter than the prebuffer starts on OUTPUT_END.

One call is one server conversation. Input is bounded to 480000 samples / 30s;
no capture is allowed between INPUT_END and LISTEN. E84 additionally waits 250ms
after PLAYBACK_DONE before enabling capture. No speech is not an INPUT_END.
Capture loss/overflow or connection loss aborts the call rather than uploading a
truncated successful turn. Server and M5 have bounded idle/progress timeouts.

The cloud v2 relay reuses the existing DoorAgent, model clients and visit policy
inside a LiveKit AgentSession. It takes the completed visitor utterance through
the existing STT client and feeds its transcript to that session. Its audio sink
waits for physical M5 playback acknowledgement. Browser `/api/connect` and the
original relay protocol continue to use LiveKit rooms. An `agent_state` event is
never treated as a DVS1 OUTPUT_END or PLAYBACK_DONE.
