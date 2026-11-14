from contextlib import nullcontext
import asyncio
import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from zoneinfo import ZoneInfo
from livekit.agents import llm
from monban_backend.voice import agent as module

async def check(status):
    with nullcontext(), nullcontext():
        agent = module.ReceptionAgent()
    message = llm.ChatMessage(role='user', content=['12時に予約した佐藤花子です。'])
    context = llm.ChatContext(items=[message])
    await agent.on_user_turn_completed(context, message)
    reservation = SimpleNamespace(event_id='r1', name='佐藤花子', start=datetime(2026,11,6,12,tzinfo=ZoneInfo('Asia/Tokyo')))
    search = AsyncMock(return_value=SimpleNamespace(status=status, reservations=[reservation] if status in {'matched','ambiguous'} else []))
    if status == 'exception':
        search.side_effect = RuntimeError('fictional reservation outage')
    seen=[]
    async def fake_model(self, ctx, tools, settings):
        seen.append((ctx,tools))
        yield 'MODEL_CONTINUATION'
    with patch.object(module.ReceptionDesk, 'search_reservations', search), patch.object(module.Agent.default, 'llm_node', fake_model), patch.object(module.ReceptionDesk, 'record_arrival', side_effect=AssertionError('prefetch must not write')), patch.object(module.ReceptionDesk, 'notify_staff_recorded', side_effect=AssertionError('prefetch must not notify')):
        output=[x async for x in agent.llm_node(context,[],None)]
        assert output==['MODEL_CONTINUATION']
        assert len(context.items)==1
        assert search.await_args.args==('佐藤花子','12:00')
        if status=='matched':
            items=seen[0][0].items
            assert len(items)==3
            assert isinstance(items[1],llm.FunctionCall)
            assert isinstance(items[2],llm.FunctionCallOutput)
            assert json.loads(items[2].output)['reservation_id']=='r1'
            assert 'r1' in agent._pending_reservations
        else:
            assert len(seen[0][0].items)==1
            assert not agent._search_attempted and not agent._pending_reservations
            assert 'search' not in agent._turn_outcomes
        await anext(agent.llm_node(context,[],None))
        assert search.await_count==1, 'prefetch repeated in same turn'
        if status in {'not_found', 'ambiguous', 'unavailable'}:
            result = json.loads(await agent.search_reservations('佐藤花子', '12:00'))
            assert result['status'] == status
            assert search.await_count == 1, 'fallback duplicated the service query'
            await agent.on_user_turn_completed(context, message)
            await agent.search_reservations('佐藤花子', '12:00')
            assert search.await_count == 2, 'new turn retained stale search cache'
    return status


import pytest

@pytest.mark.parametrize("status", ["matched", "not_found", "ambiguous", "unavailable", "exception"])
def test_prefetch_context_and_read_only_fallback(status):
    asyncio.run(check(status))
