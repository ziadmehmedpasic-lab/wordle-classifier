import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import torch

from scripts.evaluate import Config, main, make_scorer
from spoiler.data import Example, write_jsonl
from spoiler.labels import Label
from spoiler.scorer import ClaudeScorer, LMScorer, Query, Scores

CPU = torch.device("cpu")


class StubScorer:
    def score(self, queries: list[Query]) -> list[Scores]:
        out = []
        for q in queries:
            p = 0.9 if "pager" in q.text else 0.1
            out.append(
                Scores(
                    {Label.DIRECT: 0, Label.STRONG_HINT: p, Label.WEAK_HINT: 0, Label.BENIGN: 1 - p}
                )
            )
        return out


@pytest.fixture
def eval_file(tmp_path: Path) -> Path:
    rows = [
        Example("1", "wager", "rhymes with pager", Label.STRONG_HINT, "rhyme", False),
        Example("2", "wager", "today lol", Label.BENIGN, "chat", False),
        Example("3", "wager", "WAGER", Label.DIRECT, "plain", True),
        Example("4", "crane", "pager pager", Label.BENIGN, "hard_benign", False),
    ]
    write_jsonl(tmp_path / "eval.jsonl", rows)
    return tmp_path / "eval.jsonl"


def test_main_with_fixed_threshold(eval_file: Path, tmp_path: Path, capsys):
    out = main(
        Config(eval_file=eval_file, out_dir=tmp_path / "out", batch_size=2, n_boot=20), StubScorer()
    )
    report = json.loads((out / "metrics.json").read_text())
    assert report["n"] == 3 and report["recall"] == 1.0
    assert report["fp_per_10k"] == pytest.approx(5000.0)
    assert report["latency_s_per_batch"]["batch_size"] == 2
    assert (out / "dashboard.html").exists()
    assert "recall 1.000" in capsys.readouterr().out


def test_main_picks_threshold_and_keeps_caught(eval_file: Path, tmp_path: Path, monkeypatch):
    monkeypatch.setattr("scripts.evaluate.ML_DIR", tmp_path)
    cfg = Config(
        eval_file=eval_file,
        threshold_file=eval_file,
        max_fp_per_10k=0.0,
        only_passed=False,
        n_boot=20,
    )
    out = main(cfg, StubScorer())
    report = json.loads((out / "metrics.json").read_text())
    assert out.parent == tmp_path / "runs"
    assert report["n"] == 4 and report["threshold"] == pytest.approx(0.9)
    assert report["fp_per_10k"] == 0.0
    cfg = Config(eval_file=eval_file, threshold_file=eval_file, max_fp_per_10k=0.0, n_boot=20)
    report = json.loads((main(cfg, StubScorer()) / "metrics.json").read_text())
    assert report["n"] == 3


def test_make_scorer_backends(fake_model_dir: Path, tmp_path: Path, monkeypatch):
    monkeypatch.setattr("scripts.evaluate.anthropic.Anthropic", lambda: MagicMock())
    assert isinstance(make_scorer(Config(backend="claude")), ClaudeScorer)
    zero = make_scorer(Config(backend="zeroshot", base=str(fake_model_dir), device="cpu"))
    assert isinstance(zero, LMScorer)
    with pytest.raises(AssertionError, match="run-dir"):
        make_scorer(Config(backend="lora", base=str(fake_model_dir)))
    monkeypatch.setattr("spoiler.scorer.pick_device", lambda: CPU)
    monkeypatch.setattr(
        "spoiler.scorer.PeftModel.from_pretrained",
        lambda model, path: model,
    )
    tuned = make_scorer(Config(backend="lora", base=str(fake_model_dir), run_dir=tmp_path))
    assert isinstance(tuned, LMScorer)
