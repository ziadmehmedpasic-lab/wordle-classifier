"""records as written by scripts/generate.py and stamped by test/eval_data.js --write, and the
answer-grouped split used for training and evaluation."""

import json
import random
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

from spoiler.labels import Label


@dataclass(frozen=True)
class Message:
    author: str
    text: str


@dataclass(frozen=True)
class Example:
    id: str
    answer: str
    text: str
    label: Label
    style: str
    # true when layer 1 would have deleted this message before any classifier ran
    detector_hit: bool
    context: tuple[Message, ...] = ()
    extra: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> str:
        d = asdict(self)
        d["label"] = self.label.value
        d["context"] = [asdict(m) for m in self.context]
        d.update(d.pop("extra"))
        return json.dumps(d, ensure_ascii=False)


KNOWN = {"id", "answer", "text", "label", "style", "detector_hit", "context"}


def parse_example(row: dict) -> Example:
    assert "detector_hit" in row, f"{row['id']}: run node test/eval_data.js --write first"
    return Example(
        id=row["id"],
        answer=row["answer"],
        text=row["text"],
        label=Label(row["label"]),
        style=row["style"],
        detector_hit=bool(row["detector_hit"]),
        context=tuple(Message(m["author"], m["text"]) for m in row.get("context", [])),
        extra={k: str(v) for k, v in row.items() if k not in KNOWN},
    )


def load_jsonl(*paths: Path) -> list[Example]:
    rows = [json.loads(line) for p in paths for line in p.read_text().splitlines() if line]
    examples = [parse_example(r) for r in rows]
    ids = Counter(e.id for e in examples)
    dupes = [i for i, n in ids.items() if n > 1]
    assert not dupes, f"duplicate ids across inputs: {dupes[:5]}"
    return examples


def write_jsonl(path: Path, examples: list[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(e.to_json() + "\n" for e in examples))


def split_by_answer(
    examples: list[Example], seed: int, val_frac: float, test_frac: float
) -> dict[str, list[Example]]:
    """every example of one answer lands in the same split, so held-out words are truly unseen."""
    answers = sorted({e.answer for e in examples})
    random.Random(seed).shuffle(answers)
    n_test = round(len(answers) * test_frac)
    n_val = round(len(answers) * val_frac)
    assert n_test and n_val and n_test + n_val < len(answers), f"{len(answers)} answers is too few"
    where = {a: "test" for a in answers[:n_test]}
    where |= {a: "val" for a in answers[n_test : n_test + n_val]}
    splits: dict[str, list[Example]] = {"train": [], "val": [], "test": []}
    for e in examples:
        splits[where.get(e.answer, "train")].append(e)
    seen = [set(e.answer for e in s) for s in splits.values()]
    assert not (seen[0] & seen[1] or seen[0] & seen[2] or seen[1] & seen[2])
    return splits


def counts(examples: list[Example]) -> dict[str, int]:
    return {label.value: sum(e.label is label for e in examples) for label in Label}
