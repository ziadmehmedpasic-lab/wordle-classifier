"""generate labeled sft examples per answer word with claude. one request per (word, template);
direct mode calls the api sequentially, batch mode uses the message batches api at half price.
every record keeps its answer, label, style, template and generator so splits can be grouped."""

import json
import random
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Literal

import anthropic
import tyro
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request
from tqdm import tqdm

from spoiler.labels import Label

ML_DIR = Path(__file__).resolve().parent.parent
PROMPTS_DIR = ML_DIR / "prompts"
DATA_DIR = ML_DIR / "data"

STYLES = [
    "plain", "leet", "separators", "vertical", "lookalike", "emoji", "acrostic",
    "capitalization", "hidden", "inflection", "url", "definition", "synonym", "rhyme",
    "positional", "translation", "crossword", "rebus", "reference", "sequence", "category",
    "letter", "count", "theme", "wordle_chat", "chat", "hard_benign",
]  # fmt: skip

EXAMPLES_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["examples"],
    "properties": {
        "examples": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "label", "style"],
                "properties": {
                    "text": {"type": "string"},
                    "label": {"type": "string", "enum": [label.value for label in Label]},
                    "style": {"type": "string", "enum": STYLES},
                },
            },
        }
    },
}

# usd per million tokens, input then output; batch mode halves both
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


@dataclass
class Config:
    name: str = "pilot"
    words_file: Path = DATA_DIR / "answers.txt"
    # explicit words override words_file
    words: list[str] = field(default_factory=list)
    n_words: int = 10
    seed: int = 0
    templates: list[str] = field(default_factory=lambda: ["casual", "evade", "subtle"])
    # per request
    n_direct: int = 5
    n_strong: int = 5
    n_weak: int = 3
    n_benign: int = 7
    model: str = "claude-opus-5"
    mode: Literal["direct", "batch"] = "direct"
    # print the token estimate and cost, generate nothing
    estimate_only: bool = False
    out_dir: Path = DATA_DIR / "generated"
    poll_s: float = 15.0
    # parallel requests in direct mode
    concurrency: int = 8


@dataclass(frozen=True)
class Record:
    id: str
    answer: str
    text: str
    label: str
    style: str
    template_id: str
    generator: str

    def to_json(self) -> str:
        return json.dumps(self.__dict__, ensure_ascii=False)


def pick_words(cfg: Config) -> list[str]:
    if cfg.words:
        return [w.lower() for w in cfg.words]
    words = [w for w in cfg.words_file.read_text().split() if w]
    assert len(words) >= cfg.n_words, f"only {len(words)} words available"
    return random.Random(cfg.seed).sample(words, cfg.n_words)


def counts_text(cfg: Config) -> str:
    return (
        f"{cfg.n_direct} direct, {cfg.n_strong} strong_hint, {cfg.n_weak} weak_hint "
        f"and {cfg.n_benign} benign examples"
    )


@dataclass(frozen=True)
class Prompt:
    system: list[anthropic.types.TextBlockParam]
    messages: list[anthropic.types.MessageParam]


def build_prompt(cfg: Config, word: str, template: str) -> Prompt:
    system = (PROMPTS_DIR / "gen_examples.md").read_text()
    user = (PROMPTS_DIR / "gen_templates" / f"{template}.md").read_text()
    user = user.format(answer=word.upper(), counts=counts_text(cfg))
    return Prompt(
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
    )


def build_request(cfg: Config, word: str, template: str) -> MessageCreateParamsNonStreaming:
    prompt = build_prompt(cfg, word, template)
    return MessageCreateParamsNonStreaming(
        model=cfg.model,
        max_tokens=4000,
        system=prompt.system,
        messages=prompt.messages,
        output_config={"format": {"type": "json_schema", "schema": EXAMPLES_SCHEMA}},
    )


def parse_examples(text: str, word: str, template: str, model: str, prefix: str) -> list[Record]:
    data = json.loads(text)
    records = []
    for i, ex in enumerate(data["examples"]):
        records.append(
            Record(
                id=f"{prefix}-{i:02d}",
                answer=word,
                text=ex["text"],
                label=Label(ex["label"]).value,
                style=ex["style"],
                template_id=template,
                generator=model,
            )
        )
    return records


def estimate(client: anthropic.Anthropic, cfg: Config, jobs: list[tuple[str, str]]) -> float:
    """usd for the whole run, from one real token count and a guessed output length."""
    word, template = jobs[0]
    prompt = build_prompt(cfg, word, template)
    counted = client.messages.count_tokens(
        model=cfg.model, system=prompt.system, messages=prompt.messages
    )
    n_examples = cfg.n_direct + cfg.n_strong + cfg.n_weak + cfg.n_benign
    output_guess = 45 * n_examples
    price_in, price_out = PRICES[cfg.model]
    per_request = (counted.input_tokens * price_in + output_guess * price_out) / 1e6
    total = per_request * len(jobs)
    if cfg.mode == "batch":
        total /= 2
    print(
        f"{len(jobs)} requests, {counted.input_tokens} input tokens each, "
        f"~{output_guess} output tokens each, estimated ${total:.2f} ({cfg.mode})"
    )
    return total


def run_direct(
    client: anthropic.Anthropic, cfg: Config, jobs: list[tuple[str, str]]
) -> list[Record]:
    def one(job: tuple[str, str]) -> list[Record]:
        word, template = job
        response = client.messages.create(**build_request(cfg, word, template))
        assert response.stop_reason != "refusal", f"refused on {word}/{template}"
        text = next(block.text for block in response.content if block.type == "text")
        return parse_examples(text, word, template, cfg.model, f"{word}-{template}")

    with ThreadPoolExecutor(max_workers=cfg.concurrency) as pool:
        batches = list(tqdm(pool.map(one, jobs), total=len(jobs), desc="generating"))
    return [record for batch in batches for record in batch]


def run_batch(
    client: anthropic.Anthropic, cfg: Config, jobs: list[tuple[str, str]]
) -> list[Record]:
    requests = [
        Request(custom_id=f"{word}-{template}", params=build_request(cfg, word, template))
        for word, template in jobs
    ]
    batch = client.messages.batches.create(requests=requests)
    print(f"batch {batch.id} created")
    while batch.processing_status != "ended":
        time.sleep(cfg.poll_s)
        batch = client.messages.batches.retrieve(batch.id)
    by_id = {f"{word}-{template}": (word, template) for word, template in jobs}
    records: list[Record] = []
    for result in client.messages.batches.results(batch.id):
        assert result.result.type == "succeeded", f"{result.custom_id}: {result.result.type}"
        word, template = by_id[result.custom_id]
        message = result.result.message
        text = next(block.text for block in message.content if block.type == "text")
        records += parse_examples(text, word, template, cfg.model, result.custom_id)
    return records


def main(cfg: Config, client: anthropic.Anthropic | None = None) -> Path | None:
    client = client or anthropic.Anthropic()
    words = pick_words(cfg)
    jobs = [(word, template) for word in words for template in cfg.templates]
    estimate(client, cfg, jobs)
    if cfg.estimate_only:
        return None
    records = (
        run_direct(client, cfg, jobs) if cfg.mode == "direct" else run_batch(client, cfg, jobs)
    )
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    out = cfg.out_dir / f"{date.today().isoformat()}-{cfg.name}.jsonl"
    out.write_text("".join(r.to_json() + "\n" for r in records))
    print(f"wrote {len(records)} records to {out}")
    return out


if __name__ == "__main__":
    main(tyro.cli(Config))
