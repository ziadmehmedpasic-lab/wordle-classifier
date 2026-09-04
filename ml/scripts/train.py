"""lora fine-tune of a causal lm on (answer, context, message) -> label, loss on the label tokens
only. artifacts under runs/<date>-<name>/: adapter/, config.json, metrics.json."""

import json
import random
import time
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path

import torch
import tyro
from peft import LoraConfig, get_peft_model
from tqdm import tqdm
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerBase

from spoiler.data import Example, load_jsonl
from spoiler.scorer import LMScorer, Query, chat_prompt, pick_device, token_ids

ML_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ML_DIR / "data"


@dataclass
class Config:
    train_file: Path = DATA_DIR / "splits" / "train.jsonl"
    val_file: Path = DATA_DIR / "splits" / "val.jsonl"
    base: str = "Qwen/Qwen3-1.7B"
    name: str = "lora"
    runs_dir: Path = ML_DIR / "runs"
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: list[str] = field(
        default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj"]
    )
    lr: float = 2e-4
    epochs: int = 2
    batch_size: int = 8
    max_len: int = 1024
    seed: int = 0
    # train on everything by default: disguises layer 1 already catches still teach "direct"
    only_passed: bool = False
    # cuda, mps or cpu; empty picks the best available
    device: str = ""


@dataclass(frozen=True)
class Encoded:
    input_ids: list[int]
    labels: list[int]


def encode(tokenizer: PreTrainedTokenizerBase, e: Example, max_len: int) -> Encoded:
    prompt = chat_prompt(tokenizer, Query(e.answer, e.text, e.context))
    prompt_ids = token_ids(tokenizer, prompt)
    assert isinstance(tokenizer.eos_token_id, int)
    label_ids = token_ids(tokenizer, e.label.value) + [tokenizer.eos_token_id]
    ids = prompt_ids + label_ids
    assert len(ids) <= max_len, f"{e.id}: {len(ids)} tokens > max_len {max_len}"
    return Encoded(ids, [-100] * len(prompt_ids) + label_ids)


def collate(batch: list[Encoded], pad_id: int, device: torch.device) -> dict[str, torch.Tensor]:
    width = max(len(b.input_ids) for b in batch)
    ids = torch.full((len(batch), width), pad_id)
    labels = torch.full((len(batch), width), -100)
    mask = torch.zeros((len(batch), width), dtype=torch.long)
    for i, b in enumerate(batch):
        n = len(b.input_ids)
        ids[i, :n] = torch.tensor(b.input_ids)
        labels[i, :n] = torch.tensor(b.labels)
        mask[i, :n] = 1
    return {
        "input_ids": ids.to(device),
        "labels": labels.to(device),
        "attention_mask": mask.to(device),
    }


def mean_loss(model: torch.nn.Module, batches: list[dict[str, torch.Tensor]]) -> float:
    model.eval()
    with torch.no_grad():
        losses = [model(**b).loss.item() for b in batches]
    model.train()
    return sum(losses) / len(losses)


def main(cfg: Config) -> Path:
    torch.manual_seed(cfg.seed)
    device = torch.device(cfg.device) if cfg.device else pick_device()
    train = load_jsonl(cfg.train_file)
    val = load_jsonl(cfg.val_file)
    if cfg.only_passed:
        train = [e for e in train if not e.detector_hit]
        val = [e for e in val if not e.detector_hit]
    assert train and val, "empty split"

    tokenizer = AutoTokenizer.from_pretrained(cfg.base)
    assert tokenizer.pad_token_id is not None
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    base = AutoModelForCausalLM.from_pretrained(cfg.base, dtype=dtype, device_map=device)
    lora = LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=cfg.target_modules,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(base, lora)
    model.print_trainable_parameters()

    train_enc = [encode(tokenizer, e, cfg.max_len) for e in train]
    val_batches = [
        collate(
            [encode(tokenizer, e, cfg.max_len) for e in val[i : i + cfg.batch_size]],
            tokenizer.pad_token_id,
            device,
        )
        for i in range(0, len(val), cfg.batch_size)
    ]
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=cfg.lr)
    rng = random.Random(cfg.seed)
    history: list[dict[str, float]] = []
    model.train()
    for epoch in range(cfg.epochs):
        order = list(range(len(train_enc)))
        rng.shuffle(order)
        total = 0.0
        steps = range(0, len(order), cfg.batch_size)
        for start in tqdm(steps, desc=f"epoch {epoch + 1}/{cfg.epochs}"):
            batch = collate(
                [train_enc[i] for i in order[start : start + cfg.batch_size]],
                tokenizer.pad_token_id,
                device,
            )
            loss = model(**batch).loss
            loss.backward()
            opt.step()
            opt.zero_grad()
            total += loss.item()
        history.append(
            {"train_loss": total / len(steps), "val_loss": mean_loss(model, val_batches)}
        )
        print(history[-1])

    scorer = LMScorer(tokenizer, model, device, cfg.batch_size)
    t0 = time.perf_counter()
    scores = scorer.score([Query(e.answer, e.text, e.context) for e in val])
    val_acc = sum(s.label is e.label for s, e in zip(scores, val, strict=True)) / len(val)
    print(f"val accuracy {val_acc:.3f} ({time.perf_counter() - t0:.1f}s)")

    run_dir = cfg.runs_dir / f"{date.today().isoformat()}-{cfg.name}"
    run_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(run_dir / "adapter"))
    (run_dir / "config.json").write_text(json.dumps(asdict(cfg), default=str, indent=2))
    (run_dir / "metrics.json").write_text(
        json.dumps({"epochs": history, "val_accuracy": val_acc}, indent=2)
    )
    print(f"saved to {run_dir}")
    return run_dir


if __name__ == "__main__":
    main(tyro.cli(Config))
