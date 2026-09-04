import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from spoiler.judge import VERDICT_SCHEMA, Evidence, judge_image, judge_text
from spoiler.labels import Label


def fake_client(payload: dict | None, stop_reason: str = "end_turn") -> MagicMock:
    content = [SimpleNamespace(type="thinking", thinking="")]
    if payload is not None:
        content.append(SimpleNamespace(type="text", text=json.dumps(payload)))
    response = SimpleNamespace(
        stop_reason=stop_reason,
        content=content,
        usage=SimpleNamespace(input_tokens=120, output_tokens=30),
    )
    client = MagicMock()
    client.messages.create.return_value = response
    return client


def test_judge_text_parses_verdict_and_builds_prompt():
    client = fake_client({"label": "strong_hint", "confidence": 0.9, "reason": "rhyme"})
    verdict = judge_text(
        client,
        ["wager"],
        "rhymes with pager",
        context=[("bob", "wordle time"), ("amy", "ugh")],
        evidence=[Evidence("phonetic", "wajer")],
        model="claude-test",
    )
    assert verdict.label is Label.STRONG_HINT
    assert verdict.confidence == 0.9
    assert verdict.reason == "rhyme"
    assert not verdict.refused
    assert (verdict.input_tokens, verdict.output_tokens) == (120, 30)

    kwargs = client.messages.create.call_args.kwargs
    assert kwargs["model"] == "claude-test"
    assert kwargs["output_config"]["format"]["schema"] is VERDICT_SCHEMA
    assert kwargs["system"][1]["text"] == "Protected answers: WAGER."
    assert "cache_control" in kwargs["system"][0]
    user_text = kwargs["messages"][0]["content"][0]["text"]
    assert "- bob: wordle time" in user_text
    assert "- phonetic: 'wajer'" in user_text
    assert user_text.endswith("Message to judge:\nrhymes with pager")


def test_judge_text_without_context_or_evidence():
    client = fake_client({"label": "benign", "confidence": 0.8, "reason": "chat"})
    verdict = judge_text(client, ["wager", "stare"], "got it in 3")
    assert verdict.label is Label.BENIGN
    user_text = client.messages.create.call_args.kwargs["messages"][0]["content"][0]["text"]
    assert user_text == "Message to judge:\ngot it in 3"
    assert client.messages.create.call_args.kwargs["system"][1]["text"] == (
        "Protected answers: WAGER, STARE."
    )


def test_refusal_is_reported_not_hidden():
    client = fake_client(None, stop_reason="refusal")
    verdict = judge_text(client, ["wager"], "anything")
    assert verdict.refused
    assert verdict.label is Label.BENIGN
    assert verdict.confidence == 0.0


def test_judge_requires_an_answer():
    with pytest.raises(AssertionError):
        judge_text(fake_client({}), [], "text")


def test_judge_image_sends_base64_and_caption():
    client = fake_client({"label": "direct", "confidence": 1.0, "reason": "tiles"})
    verdict = judge_image(client, ["wager"], b"\x89PNG", "image/png", caption="lol")
    assert verdict.label is Label.DIRECT
    content = client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert content[0]["source"] == {"type": "base64", "media_type": "image/png", "data": "iVBORw=="}
    assert content[1]["text"] == "Message text accompanying the image: lol"
    assert "image" in client.messages.create.call_args.kwargs["system"][0]["text"].lower()


def test_judge_image_without_caption():
    client = fake_client({"label": "benign", "confidence": 0.7, "reason": "grid"})
    judge_image(client, ["wager"], b"data", "image/jpeg")
    content = client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert content[1]["text"].endswith("(none)")
