import asyncio,json
from unittest.mock import AsyncMock,patch
import pytest
from monban_backend.reception.prefetch import has_unresolved_clock_fragment
from monban_backend.voice import agent as module

@pytest.mark.parametrize('text,expected', [('11で27に予約した佐藤花子です',True),('10手16に予約した佐藤花子です',True),('12手3八の予約です',True),('11時27分です',False),('11:27です',False),('11で27、すみません11時27分です',False),('11時で、27日はどうですか',False)])
def test_fragment(text,expected):
    assert has_unresolved_clock_fragment(text)==expected

def test_no_search_or_write_for_guessed_time():
    async def run():
        agent=module.ReceptionAgent()
        agent._visitor_utterances=['11で27に予約した佐藤花子です']
        with patch.object(agent.desk,'search_reservations',AsyncMock()) as search:
            response=json.loads(await agent.search_reservations('佐藤花子','11:00'))
            assert response['code']=='appointment_time_needs_clarification'
            search.assert_not_awaited()
            assert not agent._pending_reservations
            assert '何時' in await agent._deterministic_tool_failure_reply()
    asyncio.run(run())
