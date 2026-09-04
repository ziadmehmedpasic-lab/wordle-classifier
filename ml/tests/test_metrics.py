import math

import pytest

from spoiler.labels import Label
from spoiler.metrics import Outcome, curve, pick_threshold, summarize


def outcomes() -> list[Outcome]:
    benign = [Outcome(s, Label.BENIGN, "chat") for s in (0.05, 0.1, 0.2, 0.3, 0.95)]
    hints = [Outcome(s, Label.STRONG_HINT, "rhyme") for s in (0.9, 0.8, 0.25)]
    direct = [Outcome(0.99, Label.DIRECT, "plain")]
    return benign + hints + direct


def test_pick_threshold_respects_budget():
    # budget of 0 false deletions: threshold sits at the highest benign score
    assert pick_threshold(outcomes(), 0.0) == 0.95
    # one allowed (5 benign * 2000/10k = 1): next-highest benign score
    assert pick_threshold(outcomes(), 2000.0) == 0.3
    # everything allowed
    assert pick_threshold(outcomes(), 10_000.0) == 0.0
    with pytest.raises(AssertionError, match="no benign"):
        pick_threshold([Outcome(0.5, Label.DIRECT, "plain")], 0.0)


def test_summarize_rates_and_breakdowns():
    r = summarize(outcomes(), threshold=0.3, n_boot=50, seed=1)
    assert r["recall"] == pytest.approx(3 / 4)
    assert r["fp_per_10k"] == pytest.approx(2000.0)
    assert r["recall_ci"][0] <= r["recall"] <= r["recall_ci"][1]
    assert r["by_label"]["benign"] == {"n": 5, "deleted": 0.2}
    assert "weak_hint" not in r["by_label"]
    assert r["by_style"]["rhyme"]["deleted"] == pytest.approx(2 / 3)


def test_summarize_with_one_class_is_nan():
    only = [Outcome(0.5, Label.DIRECT, "plain"), Outcome(0.9, Label.DIRECT, "plain")]
    r = summarize(only, threshold=0.7, n_boot=10)
    assert r["recall"] == 0.5 and math.isnan(r["fp_per_10k"])
    benign = [Outcome(0.5, Label.BENIGN, "chat")]
    assert math.isnan(summarize(benign, threshold=0.7, n_boot=10)["recall"])


def test_curve_is_monotone():
    points = curve(outcomes())
    assert points[0]["threshold"] == -1.0 and points[0]["recall"] == 1.0
    fps = [p["fp_per_10k"] for p in points]
    assert fps == sorted(fps, reverse=True)
    assert points[-1]["recall"] == 0.0
