# Classifier experiments

This directory contains dataset generation, training and evaluation code. The trained
scorer is not connected to the Discord bot yet.

Use Python 3.12 or newer and `uv`. From this directory:

```sh
uv sync --all-groups
uv run python scripts/build_dataset.py
uv run python scripts/evaluate.py --backend zeroshot
uv run python scripts/evaluate.py --backend claude
uv run python scripts/train.py --name lora
uv run python scripts/evaluate.py --backend lora --run-dir runs/<run> \
    --threshold-file data/splits/val.jsonl --max-fp-per-10k 50
```

Dataset generation and Claude evaluation require API credentials; training requires
suitable compute. Consult each script's `--help` for inputs and model settings.

The pattern detector runs before a model in the moderation pipeline. From the repository
root, `npm run eval:data -- --write` stamps generated records with `detector_hit` so model
evaluation can focus on messages the detector lets through. Splits group by answer.

Evaluation writes `metrics.json` and a Plotly `dashboard.html` per run, including recall,
false deletions, latency and breakdowns by label and attack style. The decision threshold
is chosen on validation data, not the final test split.

Project checks: `uv run ruff check .`, `uv run pyright`, and `uv run pytest`.
The acceptance-set and labeling rules are in [POLICY.md](../POLICY.md).
