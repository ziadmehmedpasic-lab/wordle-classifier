"""policy labels, mirrored from POLICY.md at the repo root."""

from enum import StrEnum


class Label(StrEnum):
    DIRECT = "direct"
    STRONG_HINT = "strong_hint"
    WEAK_HINT = "weak_hint"
    BENIGN = "benign"


# all non-benign levels are deleted, per POLICY.md
DELETE_LABELS: frozenset[Label] = frozenset({Label.DIRECT, Label.STRONG_HINT, Label.WEAK_HINT})


def is_deleted(label: Label) -> bool:
    return label in DELETE_LABELS
