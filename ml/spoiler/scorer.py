"""scorer backends. every backend maps (answer, context, text) to a distribution over the policy
labels; the deployment decision is a threshold on 1 - p(benign)."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast

import anthropic
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerBase

from spoiler.data import Message
from spoiler.judge import DEFAULT_MODEL, judge_text
from spoiler.labels import Label

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
LABELS = list(Label)


@dataclass(frozen=True)
class Query:
    answer: str
    text: str
    context: tuple[Message, ...] = ()


@dataclass(frozen=True)
class Scores:
    probs: dict[Label, float]

    @property
    def label(self) -> Label:
        return max(self.probs, key=lambda k: self.probs[k])

    @property
    def delete_score(self) -> float:
        return 1.0 - self.probs[Label.BENIGN]


class Scorer(Protocol):
    def score(self, queries: list[Query]) -> list[Scores]: ...


def build_prompt(q: Query) -> str:
    template = (PROMPTS_DIR / "scorer.md").read_text()
    lines = "\n".join(f"- {m.author}: {m.text}" for m in q.context)
    context = f"Recent messages, oldest first:\n{lines}\n" if q.context else ""
    return template.format(answer=q.answer.upper(), context=context, text=q.text)


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def chat_prompt(tokenizer: PreTrainedTokenizerBase, q: Query) -> str:
    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": build_prompt(q)}],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    assert isinstance(text, str)
    return text


def token_ids(tokenizer: PreTrainedTokenizerBase, text: str) -> list[int]:
    return cast(list[int], tokenizer.encode(text, add_special_tokens=False))


def label_token_ids(tokenizer: PreTrainedTokenizerBase) -> list[int]:
    """first token of each label word; the readout compares these at the answer position."""
    ids = [token_ids(tokenizer, label.value)[0] for label in LABELS]
    assert len(set(ids)) == len(ids), f"label words share a first token: {ids}"
    return ids


class LMScorer:
    """zero-shot or lora-tuned causal lm: softmax over the label tokens at the answer position."""

    def __init__(
        self,
        tokenizer: PreTrainedTokenizerBase,
        model: torch.nn.Module,
        device: torch.device,
        batch_size: int = 16,
    ):
        assert tokenizer.pad_token_id is not None, "tokenizer needs a pad token"
        self.tokenizer = tokenizer
        self.model = model.to(device).eval()
        self.device = device
        self.batch_size = batch_size
        self.label_ids = torch.tensor(label_token_ids(tokenizer), device=device)

    @classmethod
    def load(
        cls,
        base: str,
        adapter: Path | None = None,
        device: torch.device | None = None,
        batch_size: int = 16,
    ) -> "LMScorer":
        device = device or pick_device()
        dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
        tokenizer = AutoTokenizer.from_pretrained(base)
        model = AutoModelForCausalLM.from_pretrained(base, dtype=dtype, device_map=device)
        if adapter is not None:
            model = PeftModel.from_pretrained(model, str(adapter))
        return cls(tokenizer, model, device, batch_size)

    @torch.no_grad()
    def score(self, queries: list[Query]) -> list[Scores]:
        out: list[Scores] = []
        for start in range(0, len(queries), self.batch_size):
            prompts = [
                chat_prompt(self.tokenizer, q) for q in queries[start : start + self.batch_size]
            ]
            enc = self.tokenizer(
                prompts, return_tensors="pt", padding=True, add_special_tokens=False
            )
            enc = enc.to(self.device)
            logits = self.model(**enc).logits  # batch, seq, vocab
            last = enc["attention_mask"].sum(dim=1) - 1  # right padding: last real token
            at_answer = logits[torch.arange(len(prompts), device=self.device), last]
            probs = torch.softmax(at_answer[:, self.label_ids].float(), dim=-1).cpu()
            out += [Scores(dict(zip(LABELS, row.tolist(), strict=True))) for row in probs]
        return out


class ClaudeScorer:
    """hosted baseline: the judge's label and confidence, remaining mass spread over the rest."""

    def __init__(self, client: anthropic.Anthropic, model: str = DEFAULT_MODEL, workers: int = 8):
        self.client = client
        self.model = model
        self.workers = workers

    def score(self, queries: list[Query]) -> list[Scores]:
        def one(q: Query) -> Scores:
            context = [(m.author, m.text) for m in q.context]
            v = judge_text(self.client, [q.answer], q.text, context=context, model=self.model)
            if v.refused:
                return Scores({label: float(label is Label.BENIGN) for label in LABELS})
            rest = (1.0 - v.confidence) / (len(LABELS) - 1)
            return Scores({label: v.confidence if label is v.label else rest for label in LABELS})

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            return list(pool.map(one, queries))
