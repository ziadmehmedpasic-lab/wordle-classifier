"""score a labeled file with one backend, fix or apply a threshold, and write metrics.json plus a
plotly dashboard. by default only records that pass layer 1 count, since the bot deletes the rest
before any classifier runs."""

import json
import time
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Literal

import anthropic
import numpy as np
import plotly.graph_objects as go
import tyro
from plotly.subplots import make_subplots

from spoiler.data import Example, load_jsonl
from spoiler.judge import DEFAULT_MODEL
from spoiler.metrics import Outcome, curve, pick_threshold, summarize
from spoiler.scorer import ClaudeScorer, LMScorer, Query, Scorer

ML_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ML_DIR / "data"


@dataclass
class Config:
    backend: Literal["zeroshot", "lora", "claude"] = "zeroshot"
    base: str = "Qwen/Qwen3-1.7B"
    # lora: the training run directory holding adapter/
    run_dir: Path | None = None
    claude_model: str = DEFAULT_MODEL
    eval_file: Path = DATA_DIR / "acceptance.jsonl"
    # pick the threshold on this file at max_fp_per_10k; otherwise use threshold as given
    threshold_file: Path | None = None
    threshold: float = 0.5
    max_fp_per_10k: float = 50.0
    only_passed: bool = True
    out_dir: Path | None = None
    batch_size: int = 16
    n_boot: int = 1000
    seed: int = 0
    device: str = ""


def make_scorer(cfg: Config) -> Scorer:
    if cfg.backend == "claude":
        return ClaudeScorer(anthropic.Anthropic(), cfg.claude_model)
    import torch

    device = torch.device(cfg.device) if cfg.device else None
    adapter = None
    if cfg.backend == "lora":
        assert cfg.run_dir is not None, "lora backend needs --run-dir"
        adapter = cfg.run_dir / "adapter"
    return LMScorer.load(cfg.base, adapter, device, cfg.batch_size)


def score_file(
    scorer: Scorer, examples: list[Example], batch_size: int
) -> tuple[list[Outcome], list[float]]:
    """outcomes plus wall-clock seconds per batch of batch_size queries."""
    outcomes: list[Outcome] = []
    latencies: list[float] = []
    for start in range(0, len(examples), batch_size):
        chunk = examples[start : start + batch_size]
        t0 = time.perf_counter()
        scores = scorer.score([Query(e.answer, e.text, e.context) for e in chunk])
        latencies.append(time.perf_counter() - t0)
        outcomes += [
            Outcome(s.delete_score, e.label, e.style) for s, e in zip(scores, chunk, strict=True)
        ]
    return outcomes, latencies


def dashboard(
    points: list[dict[str, float]], by_style: dict[str, dict], threshold: float, path: Path
) -> None:
    fig = make_subplots(
        rows=1, cols=2, subplot_titles=("recall vs false deletions", "deleted fraction by style")
    )
    fig.add_trace(
        go.Scatter(
            x=[p["fp_per_10k"] for p in points],
            y=[p["recall"] for p in points],
            mode="lines+markers",
            name="tradeoff",
            text=[f"threshold {p['threshold']:.3f}" for p in points],
        ),
        row=1,
        col=1,
    )
    styles = sorted(by_style, key=lambda s: by_style[s]["deleted"])
    fig.add_trace(
        go.Bar(x=styles, y=[by_style[s]["deleted"] for s in styles], name="deleted_by_style"),
        row=1,
        col=2,
    )
    fig.update_xaxes(title_text="false deletions per 10k benign", row=1, col=1)
    fig.update_yaxes(title_text="recall of deleted labels", row=1, col=1)
    fig.update_layout(title=f"threshold {threshold:.3f}", showlegend=False)
    fig.write_html(path, include_plotlyjs="cdn")


def main(cfg: Config, scorer: Scorer | None = None) -> Path:
    scorer = scorer or make_scorer(cfg)
    examples = load_jsonl(cfg.eval_file)
    if cfg.only_passed:
        examples = [e for e in examples if not e.detector_hit]
    assert examples, "nothing to evaluate"
    threshold = cfg.threshold
    if cfg.threshold_file is not None:
        cal = load_jsonl(cfg.threshold_file)
        if cfg.only_passed:
            cal = [e for e in cal if not e.detector_hit]
        threshold = pick_threshold(score_file(scorer, cal, cfg.batch_size)[0], cfg.max_fp_per_10k)
        print(
            f"threshold {threshold:.3f} at {cfg.max_fp_per_10k} fp/10k on {cfg.threshold_file.name}"
        )

    outcomes, latencies = score_file(scorer, examples, cfg.batch_size)
    report = summarize(outcomes, threshold, cfg.n_boot, cfg.seed)
    report["latency_s_per_batch"] = {
        "batch_size": cfg.batch_size,
        "p50": float(np.percentile(latencies, 50)),
        "p95": float(np.percentile(latencies, 95)),
    }
    report["config"] = {k: str(v) for k, v in asdict(cfg).items()}
    out_dir = cfg.out_dir or ML_DIR / "runs" / f"{date.today().isoformat()}-eval-{cfg.backend}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(report, indent=2))
    dashboard(curve(outcomes), report["by_style"], threshold, out_dir / "dashboard.html")
    print(
        f"{cfg.backend}: recall {report['recall']:.3f} {report['recall_ci']}, "
        f"fp/10k {report['fp_per_10k']:.1f} {report['fp_per_10k_ci']} on {report['n']} records"
    )
    return out_dir


if __name__ == "__main__":
    main(tyro.cli(Config))
