import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import PreTrainedTokenizerFast

from spoiler.data import Message
from spoiler.labels import Label
from spoiler.scorer import (
    ClaudeScorer,
    LMScorer,
    Query,
    Scores,
    build_prompt,
    label_token_ids,
    pick_device,
)

CPU = torch.device("cpu")


def test_scores_label_and_delete_score():
    s = Scores({Label.DIRECT: 0.1, Label.STRONG_HINT: 0.6, Label.WEAK_HINT: 0.1, Label.BENIGN: 0.2})
    assert s.label is Label.STRONG_HINT
    assert s.delete_score == pytest.approx(0.8)


def test_build_prompt_with_and_without_context():
    q = Query("wager", "rhymes with pager", (Message("bob", "wordle time"),))
    text = build_prompt(q)
    assert "Today's answer: WAGER" in text
    assert "- bob: wordle time" in text
    assert "Message: rhymes with pager" in text
    assert "Recent messages" not in build_prompt(Query("wager", "hi"))


def test_label_token_ids_must_be_distinct():
    tok = Tokenizer(models.WordLevel({"<unk>": 0, "x": 1}, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=tok, unk_token="<unk>")
    with pytest.raises(AssertionError, match="share a first token"):
        label_token_ids(tokenizer)


def test_lm_scorer_zero_shot(fake_model_dir: Path):
    scorer = LMScorer.load(str(fake_model_dir), device=CPU, batch_size=2)
    queries = [
        Query("wager", "rhymes with pager"),
        Query("crane", "today lol", (Message("bob", "hi"),)),
        Query("plane", "WAGER"),
    ]
    scores = scorer.score(queries)
    assert len(scores) == 3
    for s in scores:
        assert sum(s.probs.values()) == pytest.approx(1.0)
        assert 0.0 <= s.delete_score <= 1.0
    # batching must not change the numbers
    single = scorer.score(queries[1:2])[0]
    assert single.probs[Label.BENIGN] == pytest.approx(scores[1].probs[Label.BENIGN], abs=1e-5)


def test_lm_scorer_requires_pad_token(fake_model_dir: Path):
    scorer = LMScorer.load(str(fake_model_dir), device=CPU)
    scorer.tokenizer.pad_token = None
    with pytest.raises(AssertionError, match="pad token"):
        LMScorer(scorer.tokenizer, scorer.model, CPU)


def test_pick_device(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert pick_device().type == "cuda"
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    assert pick_device().type == "mps"
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    assert pick_device().type == "cpu"


def fake_client(payload: dict | None, stop_reason: str = "end_turn") -> MagicMock:
    content = [SimpleNamespace(type="text", text=json.dumps(payload))] if payload else []
    client = MagicMock()
    client.messages.create.return_value = SimpleNamespace(
        stop_reason=stop_reason,
        content=content,
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )
    return client


def test_claude_scorer_spreads_confidence_and_handles_refusal():
    client = fake_client({"label": "weak_hint", "confidence": 0.7, "reason": "category"})
    scores = ClaudeScorer(client, "m", workers=2).score(
        [Query("wager", "casino stuff", (Message("a", "b"),))]
    )
    assert scores[0].label is Label.WEAK_HINT
    assert scores[0].probs[Label.BENIGN] == pytest.approx(0.1)
    assert sum(scores[0].probs.values()) == pytest.approx(1.0)
    refused = ClaudeScorer(fake_client(None, "refusal"), "m").score([Query("wager", "x")])
    assert refused[0].probs[Label.BENIGN] == 1.0 and refused[0].delete_score == 0.0
