import json
from pathlib import Path

import pytest

from scripts.build_dataset import Config, main
from spoiler.data import (
    Example,
    Message,
    counts,
    load_jsonl,
    parse_example,
    split_by_answer,
    write_jsonl,
)
from spoiler.labels import Label


def row(i: int, answer: str, label: str = "benign", hit: bool = False) -> dict:
    return {
        "id": f"{answer}-{i}",
        "answer": answer,
        "text": f"msg {i}",
        "label": label,
        "style": "chat",
        "detector_hit": hit,
        "context": [{"author": "bob", "text": "hi"}] if i % 2 else [],
        "template_id": "casual",
    }


def write(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def test_parse_and_roundtrip(tmp_path: Path):
    e = parse_example(row(1, "wager", "direct", True))
    assert e.label is Label.DIRECT and e.detector_hit
    assert e.context == (Message("bob", "hi"),)
    assert e.extra == {"template_id": "casual"}
    back = json.loads(e.to_json())
    assert back["template_id"] == "casual" and back["label"] == "direct"
    write_jsonl(tmp_path / "x" / "out.jsonl", [e])
    assert load_jsonl(tmp_path / "x" / "out.jsonl") == [e]
    with pytest.raises(AssertionError, match="eval_data"):
        parse_example({k: v for k, v in row(2, "wager").items() if k != "detector_hit"})


def test_load_rejects_duplicate_ids(tmp_path: Path):
    a = write(tmp_path / "a.jsonl", [row(1, "wager")])
    b = write(tmp_path / "b.jsonl", [row(1, "wager")])
    with pytest.raises(AssertionError, match="duplicate"):
        load_jsonl(a, b)


def test_split_keeps_answers_together():
    answers = [f"w{i:02d}" for i in range(20)]
    examples = [
        parse_example(row(i, a, "direct" if i % 2 else "benign")) for a in answers for i in range(3)
    ]
    splits = split_by_answer(examples, seed=1, val_frac=0.2, test_frac=0.2)
    assert sum(len(s) for s in splits.values()) == len(examples)
    seen = {name: {e.answer for e in rows} for name, rows in splits.items()}
    assert len(seen["test"]) == 4 and len(seen["val"]) == 4
    assert not (seen["train"] & seen["val"]) and not (seen["train"] & seen["test"])
    assert split_by_answer(examples, 1, 0.2, 0.2) == splits
    assert counts(splits["train"]) == {"direct": 12, "strong_hint": 0, "weak_hint": 0, "benign": 24}
    with pytest.raises(AssertionError, match="too few"):
        split_by_answer(examples[:6], seed=0, val_frac=0.2, test_frac=0.2)


def test_build_dataset_writes_splits(tmp_path: Path, capsys):
    answers = [f"w{i:02d}" for i in range(10)]
    src = write(
        tmp_path / "gen.jsonl", [row(i, a, hit=bool(i % 2)) for a in answers for i in range(2)]
    )
    out = main(Config(inputs=[src], out_dir=tmp_path / "splits", val_frac=0.2, test_frac=0.2))
    assert set(out) == {"train", "val", "test"} and all(p.exists() for p in out.values())
    assert len(load_jsonl(out["train"])) == 12
    assert "reaching the classifier" in capsys.readouterr().out


def test_build_dataset_defaults_to_generated_dir(tmp_path: Path, monkeypatch):
    answers = [f"w{i:02d}" for i in range(10)]
    gen = tmp_path / "generated"
    gen.mkdir()
    write(gen / "a.jsonl", [row(i, a) for a in answers for i in range(2)])
    monkeypatch.setattr("scripts.build_dataset.DATA_DIR", tmp_path)
    out = main(Config(out_dir=tmp_path / "splits", val_frac=0.2, test_frac=0.2))
    assert isinstance(load_jsonl(out["test"])[0], Example)
