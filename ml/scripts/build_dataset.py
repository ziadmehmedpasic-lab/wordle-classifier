"""split stamped generated records into train/val/test by answer. usage: build_dataset.py
[--inputs a.jsonl b.jsonl] [--out-dir data/splits]"""

from dataclasses import dataclass, field
from pathlib import Path

import tyro

from spoiler.data import counts, load_jsonl, split_by_answer, write_jsonl

ML_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ML_DIR / "data"


@dataclass
class Config:
    # defaults to every file under data/generated
    inputs: list[Path] = field(default_factory=list)
    out_dir: Path = DATA_DIR / "splits"
    seed: int = 0
    val_frac: float = 0.15
    test_frac: float = 0.15


def main(cfg: Config) -> dict[str, Path]:
    inputs = cfg.inputs or sorted((DATA_DIR / "generated").glob("*.jsonl"))
    examples = load_jsonl(*inputs)
    splits = split_by_answer(examples, cfg.seed, cfg.val_frac, cfg.test_frac)
    out: dict[str, Path] = {}
    for name, rows in splits.items():
        out[name] = cfg.out_dir / f"{name}.jsonl"
        write_jsonl(out[name], rows)
        passed = [e for e in rows if not e.detector_hit]
        answers = len({e.answer for e in rows})
        print(f"{name}: {len(rows)} records, {answers} answers, {counts(rows)}")
        print(f"  reaching the classifier: {len(passed)} {counts(passed)}")
    return out


if __name__ == "__main__":
    main(tyro.cli(Config))
