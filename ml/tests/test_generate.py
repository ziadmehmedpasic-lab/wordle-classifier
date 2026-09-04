import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from scripts.generate import (
    EXAMPLES_SCHEMA,
    STYLES,
    Config,
    build_prompt,
    build_request,
    estimate,
    main,
    parse_examples,
    pick_words,
    style_plan,
)
from spoiler.labels import Label

PAYLOAD = {
    "examples": [
        {"text": "w8g3r", "label": "direct", "style": "leet", "context": []},
        {"text": "rhymes with pager", "label": "strong_hint", "style": "rhyme", "context": []},
        {
            "text": "and it rhymes with pager",
            "label": "strong_hint",
            "style": "multi_strong",
            "context": [{"author": "bob", "text": "gambling word today"}],
        },
    ]
}


def text_response(payload: dict, stop_reason: str = "end_turn") -> SimpleNamespace:
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="text", text=json.dumps(payload))],
    )


def fake_client() -> MagicMock:
    client = MagicMock()
    client.messages.count_tokens.return_value = SimpleNamespace(input_tokens=1000)
    client.messages.create.return_value = text_response(PAYLOAD)
    return client


def test_pick_words_samples_from_file_deterministically(tmp_path: Path):
    words_file = tmp_path / "answers.txt"
    words_file.write_text("crane\nstare\nwager\nlight\n")
    cfg = Config(words_file=words_file, n_words=2, seed=1)
    assert pick_words(cfg) == pick_words(cfg)
    assert len(set(pick_words(cfg))) == 2
    assert pick_words(Config(words=["WAGER"])) == ["wager"]
    with pytest.raises(AssertionError):
        pick_words(Config(words_file=words_file, n_words=9))


def test_build_request_fills_template_and_schema():
    cfg = Config(n_direct=1, n_strong=2, n_weak=3, n_benign=4, model="claude-sonnet-5")
    prompt = build_prompt(cfg, "wager", "evade")
    user = prompt.messages[0]["content"]
    assert isinstance(user, str)
    assert "WAGER" in user
    assert "Styles to produce, one example each:" in user
    assert "- weak_hint: " in user
    assert "spoiler filter" in user
    assert "cache_control" in prompt.system[0]
    req = build_request(cfg, "wager", "evade")
    assert req["model"] == "claude-sonnet-5"
    assert req.get("output_config") == {
        "format": {"type": "json_schema", "schema": EXAMPLES_SCHEMA}
    }


def test_style_plan_is_deterministic_and_cycles():
    cfg = Config(n_direct=2, n_strong=1, n_weak=9, n_benign=3, n_multi_direct=1, seed=4)
    plan = style_plan(cfg, "wager", "casual")
    assert plan == style_plan(cfg, "wager", "casual")
    assert plan != style_plan(cfg, "stare", "casual")
    assert len(plan[Label.DIRECT]) == 3 and len(set(plan[Label.DIRECT][:2])) == 2
    # only four weak styles exist, so nine picks cycle through them
    assert len(plan[Label.WEAK_HINT]) == 9 and set(plan[Label.WEAK_HINT]) == set(STYLES[20:24])
    assert set(plan[Label.BENIGN]) == {"wordle_chat", "chat", "hard_benign", "multi_benign"}
    assert plan[Label.DIRECT][-1] == "multi_direct" and plan[Label.STRONG_HINT][-2:] == [
        "multi_strong",
        "multi_strong",
    ]
    assert "multi" not in "".join(plan[Label.WEAK_HINT])


def test_parse_examples_records():
    records = parse_examples(json.dumps(PAYLOAD), "wager", "casual", "m", "wager-casual")
    assert [r.id for r in records] == ["wager-casual-00", "wager-casual-01", "wager-casual-02"]
    assert records[0].answer == "wager"
    assert records[1].label == "strong_hint"
    assert records[0].context == []
    assert records[2].context == [{"author": "bob", "text": "gambling word today"}]
    assert json.loads(records[2].to_json())["context"][0]["author"] == "bob"
    with pytest.raises(ValueError):
        parse_examples(
            json.dumps(
                {"examples": [{"text": "x", "label": "bad", "style": "chat", "context": []}]}
            ),
            "w",
            "t",
            "m",
            "p",
        )


def test_estimate_prices_direct_and_batch(capsys):
    cfg = Config(
        model="claude-opus-5", n_direct=5, n_strong=5, n_weak=3, n_benign=7,
        n_multi_direct=1, n_multi_strong=2, n_multi_benign=2,
    )  # fmt: skip
    jobs = [("wager", "casual"), ("stare", "casual")]
    # 1000 input * 5 + (20 * 45 + 5 * 120) output * 25 per request, two requests
    per_request = (1000 * 5 + 1500 * 25) / 1e6
    assert estimate(fake_client(), cfg, jobs) == pytest.approx(per_request * 2)
    cfg.mode = "batch"
    assert estimate(fake_client(), cfg, jobs) == pytest.approx(per_request)
    assert "estimated $" in capsys.readouterr().out


def test_main_direct_mode_writes_jsonl(tmp_path: Path):
    cfg = Config(words=["wager"], templates=["casual", "subtle"], out_dir=tmp_path, name="t")
    out = main(cfg, client=fake_client())
    assert out is not None and out.name.endswith("-t.jsonl")
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert len(rows) == 6
    assert {r["template_id"] for r in rows} == {"casual", "subtle"}
    assert rows[0]["generator"] == "claude-opus-5"


def test_main_estimate_only_calls_nothing(tmp_path: Path):
    client = fake_client()
    cfg = Config(words=["wager"], out_dir=tmp_path, estimate_only=True)
    assert main(cfg, client=client) is None
    client.messages.create.assert_not_called()


def test_direct_mode_refusal_is_an_error(tmp_path: Path):
    client = fake_client()
    client.messages.create.return_value = text_response({}, stop_reason="refusal")
    with pytest.raises(AssertionError):
        main(Config(words=["wager"], templates=["casual"], out_dir=tmp_path), client=client)


def test_main_batch_mode(tmp_path: Path, monkeypatch):
    client = fake_client()
    client.messages.batches.create.return_value = SimpleNamespace(
        id="b1", processing_status="in_progress"
    )
    client.messages.batches.retrieve.return_value = SimpleNamespace(
        id="b1", processing_status="ended"
    )
    client.messages.batches.results.return_value = [
        SimpleNamespace(
            custom_id="wager-casual",
            result=SimpleNamespace(type="succeeded", message=text_response(PAYLOAD)),
        )
    ]
    slept: list[float] = []
    monkeypatch.setattr("scripts.generate.time.sleep", slept.append)
    cfg = Config(words=["wager"], templates=["casual"], out_dir=tmp_path, mode="batch")
    out = main(cfg, client=client)
    assert out is not None
    assert len(out.read_text().splitlines()) == 3
    assert slept == [cfg.poll_s]
    requests = client.messages.batches.create.call_args.kwargs["requests"]
    assert requests[0]["custom_id"] == "wager-casual"


def test_batch_mode_failed_result_is_an_error(tmp_path: Path, monkeypatch):
    client = fake_client()
    client.messages.batches.create.return_value = SimpleNamespace(
        id="b1", processing_status="ended"
    )
    client.messages.batches.results.return_value = [
        SimpleNamespace(custom_id="wager-casual", result=SimpleNamespace(type="errored"))
    ]
    cfg = Config(words=["wager"], templates=["casual"], out_dir=tmp_path, mode="batch")
    with pytest.raises(AssertionError):
        main(cfg, client=client)
