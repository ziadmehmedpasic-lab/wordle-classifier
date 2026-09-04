"""deployment metrics: the headline is false deletions per 10k benign messages at a threshold on
the delete score, and recall of the deleted labels at that threshold."""

from dataclasses import dataclass

import numpy as np

from spoiler.labels import Label, is_deleted


@dataclass(frozen=True)
class Outcome:
    delete_score: float
    label: Label
    style: str


def _arrays(outcomes: list[Outcome]) -> tuple[np.ndarray, np.ndarray]:
    scores = np.array([o.delete_score for o in outcomes], dtype=float)
    should = np.array([is_deleted(o.label) for o in outcomes], dtype=bool)
    return scores, should


def pick_threshold(outcomes: list[Outcome], max_fp_per_10k: float) -> float:
    """lowest threshold (delete when score > threshold) whose false-deletion rate on the benign
    outcomes stays within the budget."""
    scores, should = _arrays(outcomes)
    benign = np.sort(scores[~should])[::-1]
    assert len(benign), "no benign outcomes to set a threshold on"
    allowed = int(len(benign) * max_fp_per_10k / 10_000)
    if allowed >= len(benign):
        return 0.0
    return float(benign[allowed])


def _rates(scores: np.ndarray, should: np.ndarray, threshold: float) -> tuple[float, float]:
    deleted = scores > threshold
    recall = float(deleted[should].mean()) if should.any() else float("nan")
    fp = float(deleted[~should].mean() * 10_000) if (~should).any() else float("nan")
    return recall, fp


def summarize(outcomes: list[Outcome], threshold: float, n_boot: int = 1000, seed: int = 0) -> dict:
    scores, should = _arrays(outcomes)
    recall, fp = _rates(scores, should, threshold)
    rng = np.random.default_rng(seed)
    boots = np.array(
        [
            _rates(scores[idx], should[idx], threshold)
            for idx in rng.integers(0, len(scores), (n_boot, len(scores)))
        ]
    )
    lo, hi = np.nanpercentile(boots, [2.5, 97.5], axis=0)
    by_label = {}
    for label in Label:
        mask = np.array([o.label is label for o in outcomes])
        if mask.any():
            by_label[label.value] = {
                "n": int(mask.sum()),
                "deleted": float((scores[mask] > threshold).mean()),
            }
    by_style = {}
    for style in sorted({o.style for o in outcomes}):
        mask = np.array([o.style == style for o in outcomes])
        by_style[style] = {
            "n": int(mask.sum()),
            "deleted": float((scores[mask] > threshold).mean()),
        }
    return {
        "threshold": threshold,
        "n": len(outcomes),
        "recall": recall,
        "recall_ci": [float(lo[0]), float(hi[0])],
        "fp_per_10k": fp,
        "fp_per_10k_ci": [float(lo[1]), float(hi[1])],
        "by_label": by_label,
        "by_style": by_style,
    }


def curve(outcomes: list[Outcome]) -> list[dict[str, float]]:
    """recall and false deletions at every threshold the data can distinguish."""
    scores, should = _arrays(outcomes)
    points = []
    for t in np.unique(np.concatenate([[-1.0], scores])):
        recall, fp = _rates(scores, should, float(t))
        points.append({"threshold": float(t), "recall": recall, "fp_per_10k": fp})
    return points
