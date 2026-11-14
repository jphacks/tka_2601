import asyncio
import logging
from livekit.agents import llm
from monban_backend.voice import agent as module


def make_agent():
    return module.ReceptionAgent()


def test_tool_outcome_log_excludes_personal_payload(caplog):
    agent=make_agent()
    payload={"status":"error","code":"notification_record_failed","customer_name":"秘密の氏名","reservation_id":"private-id","reason":"private message"}
    with caplog.at_level(logging.INFO,logger="door-agent"):
        agent._record_tool_outcome("notify_staff",payload)
    assert agent._turn_outcomes["notify_staff"] is payload
    assert "operation=notify_staff" in caplog.text
    assert "status=error" in caplog.text and "code=notification_record_failed" in caplog.text
    assert "turn_id="+agent._audit_turn_id in caplog.text
    for secret in ["秘密の氏名","private-id","private message"]:
        assert secret not in caplog.text


def test_audit_turn_id_changes_on_each_finalized_user_turn():
    agent=make_agent();first=agent._audit_turn_id
    message=llm.ChatMessage(role="user",content=["こんにちは"])
    asyncio.run(agent.on_user_turn_completed(None,message));second=agent._audit_turn_id
    asyncio.run(agent.on_user_turn_completed(None,message));third=agent._audit_turn_id
    assert len({first,second,third})==3
