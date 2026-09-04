import json
from pathlib import Path

import pytest
import torch
from transformers import AutoTokenizer

from scripts.train import Config, encode, main
from spoiler.data import Example, Message, write_jsonl
from spoiler.labels import Label
from spoiler.scorer import LMScorer, Query

CPU = torch.device("cpu")


def examples(answers: list[str], hit: bool = False) -> list[Example]:
    out = []
    for a in answers:
        out.append(Example(f"{a}-1", a, "rhymes with pager", Label.STRONG_HINT, "rhyme", hit))
        out.append(
            Example(f"{a}-2", a, "today lol", Label.BENIGN, "chat", False, (Message("bob", "hi"),))
        )
    return out


@pytest.fixture
def splits(tmp_path: Path) -> tuple[Path, Path]:
    train, val = tmp_path / "train.jsonl", tmp_path / "val.jsonl"
    write_jsonl(train, examples(["wager", "crane"], hit=True))
    write_jsonl(val, examples(["plane"]))
    return train, val


def test_encode_masks_prompt(fake_model_dir: Path):
    tokenizer = AutoTokenizer.from_pretrained(fake_model_dir)
    e = Example("x", "wager", "rhymes with pager", Label.DIRECT, "plain", True)
    enc = encode(tokenizer, e, max_len=128)
    assert len(enc.input_ids) == len(enc.labels)
    assert enc.labels[-1] == tokenizer.eos_token_id
    assert enc.labels[-2] == tokenizer.encode("direct", add_special_tokens=False)[0]
    assert set(enc.labels[:-2]) == {-100}
    with pytest.raises(AssertionError, match="max_len"):
        encode(tokenizer, e, max_len=4)


def test_train_writes_adapter_and_metrics(
    fake_model_dir: Path, splits: tuple[Path, Path], tmp_path: Path
):
    train, val = splits
    cfg = Config(
        train_file=train,
        val_file=val,
        base=str(fake_model_dir),
        name="t",
        runs_dir=tmp_path / "runs",
        epochs=2,
        batch_size=3,
        max_len=128,
        device="cpu",
    )
    run_dir = main(cfg)
    metrics = json.loads((run_dir / "metrics.json").read_text())
    assert len(metrics["epochs"]) == 2 and 0.0 <= metrics["val_accuracy"] <= 1.0
    assert json.loads((run_dir / "config.json").read_text())["base"] == str(fake_model_dir)
    tuned = LMScorer.load(str(fake_model_dir), run_dir / "adapter", CPU)
    assert sum(tuned.score([Query("plane", "hi")])[0].probs.values()) == pytest.approx(1.0)


def test_train_only_passed_and_auto_device(
    fake_model_dir: Path, splits: tuple[Path, Path], tmp_path: Path, monkeypatch
):
    train, val = splits
    monkeypatch.setattr("scripts.train.pick_device", lambda: CPU)
    cfg = Config(
        train_file=train,
        val_file=val,
        base=str(fake_model_dir),
        runs_dir=tmp_path,
        epochs=1,
        only_passed=True,
        max_len=128,
    )
    assert (main(cfg) / "adapter").is_dir()
    write_jsonl(train, examples(["wager"], hit=True)[:1])
    with pytest.raises(AssertionError, match="empty split"):
        main(cfg)
