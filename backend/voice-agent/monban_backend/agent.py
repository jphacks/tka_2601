"""LiveKit worker entrypoint.

Run with ``python -m monban_backend.agent start``. The implementation lives in
:mod:`monban_backend.voice.agent`; this module keeps the command stable and
re-exports the agent classes used by tests and extensions.
"""

from __future__ import annotations

from livekit import agents

from .voice.agent import ReceptionAgent, _context_with_state_instructions, server

__all__ = ["ReceptionAgent", "_context_with_state_instructions", "server"]


if __name__ == "__main__":
    agents.cli.run_app(server)
