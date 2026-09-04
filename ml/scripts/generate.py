"""generate labeled sft examples per answer word with claude. one request per (word, template);
direct mode calls the api sequentially, batch mode uses the message batches api at half price.
every record keeps its answer, label, style, template and generator so splits can be grouped."""

import json
import random
import re
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

STYLES_BY_LABEL: dict[Label, list[str]] = {
    Label.DIRECT: [
        "plain", "leet", "separators", "vertical", "lookalike", "emoji", "acrostic",
        "capitalization", "inflection", "url", "phonetic",
    ],  # "hidden" (letters across a word boundary) is deliberately absent: see POLICY.md
    Label.STRONG_HINT: [
        "definition", "synonym", "rhyme", "positional", "translation", "crossword", "rebus",
        "reference", "sequence", "edit",
    ],
    Label.WEAK_HINT: ["category", "letter", "count", "theme"],
    Label.BENIGN: ["wordle_chat", "chat", "hard_benign"],
}  # fmt: skip
# exchanges of several messages; the label applies to the final message given the context
MULTI_STYLES: dict[Label, str] = {
    Label.DIRECT: "multi_direct",
    Label.STRONG_HINT: "multi_strong",
    Label.BENIGN: "multi_benign",
}
STYLES = [style for styles in STYLES_BY_LABEL.values() for style in styles] + list(
    MULTI_STYLES.values()
)

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
                "required": ["text", "label", "style", "context"],
                "properties": {
                    "text": {"type": "string"},
                    "label": {"type": "string", "enum": [label.value for label in Label]},
                    "style": {"type": "string", "enum": STYLES},
                    "context": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["author", "text"],
                            "properties": {
                                "author": {"type": "string"},
                                "text": {"type": "string"},
                            },
                        },
                    },
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
    # multi-message exchanges per request, on top of the counts above
    # multi_direct exists but is off by default: the generator rarely gets it right, and letter
    # fragments across messages are a bot rule anyway
    n_multi_direct: int = 0
    n_multi_strong: int = 2
    n_multi_benign: int = 2
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
    # earlier messages as (author, text), oldest first; empty for single-message examples
    context: list[dict[str, str]]

    def to_json(self) -> str:
        return json.dumps(self.__dict__, ensure_ascii=False)


def pick_words(cfg: Config) -> list[str]:
    if cfg.words:
        return [w.lower() for w in cfg.words]
    words = [w for w in cfg.words_file.read_text().split() if w]
    assert len(words) >= cfg.n_words, f"only {len(words)} words available"
    return random.Random(cfg.seed).sample(words, cfg.n_words)


def style_plan(cfg: Config, word: str, template: str) -> dict[Label, list[str]]:
    """which styles this request must produce, sampled per (word, template) so coverage is
    even across a run. cycles through the label's styles when more are asked than exist."""
    rng = random.Random(f"{cfg.seed}:{word}:{template}")
    wanted = {
        Label.DIRECT: cfg.n_direct,
        Label.STRONG_HINT: cfg.n_strong,
        Label.WEAK_HINT: cfg.n_weak,
        Label.BENIGN: cfg.n_benign,
    }
    plan: dict[Label, list[str]] = {}
    for label, n in wanted.items():
        styles = STYLES_BY_LABEL[label]
        picks: list[str] = []
        while len(picks) < n:
            picks += rng.sample(styles, min(len(styles), n - len(picks)))
        plan[label] = picks
    multi = {
        Label.DIRECT: cfg.n_multi_direct,
        Label.STRONG_HINT: cfg.n_multi_strong,
        Label.BENIGN: cfg.n_multi_benign,
    }
    for label, n in multi.items():
        plan[label] += [MULTI_STYLES[label]] * n
    return plan


def plan_text(plan: dict[Label, list[str]]) -> str:
    lines = [f"- {label.value}: {', '.join(styles)}" for label, styles in plan.items()]
    return "Styles to produce, one example each:\n" + "\n".join(lines)


@dataclass(frozen=True)
class Prompt:
    system: list[anthropic.types.TextBlockParam]
    messages: list[anthropic.types.MessageParam]


def build_prompt(cfg: Config, word: str, template: str) -> Prompt:
    system = (PROMPTS_DIR / "gen_examples.md").read_text()
    user = (PROMPTS_DIR / "gen_templates" / f"{template}.md").read_text()
    user = user.format(answer=word.upper(), plan=plan_text(style_plan(cfg, word, template)))
    return Prompt(
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
    )


def build_request(cfg: Config, word: str, template: str) -> MessageCreateParamsNonStreaming:
    prompt = build_prompt(cfg, word, template)
    return MessageCreateParamsNonStreaming(
        model=cfg.model,
        max_tokens=12000,
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
                context=[{"author": c["author"], "text": c["text"]} for c in ex["context"]],
            )
        )
    return records


def contains_answer(text: str, answer: str) -> bool:
    """the answer or a plain inflection of it as a whole word. per POLICY.md that is direct, so a
    non-direct example containing it is mislabeled. word-boundary runs like "saw a german" are
    deliberately not matched."""
    stem = answer[:-1] if answer.endswith("e") else answer
    pattern = rf"\b(?:{answer}(?:s|es|d|ed|r|er|est|ing)?|{stem}ing)\b"
    return re.search(pattern, text.lower()) is not None


def drop_mislabeled(records: list[Record]) -> list[Record]:
    """non-direct records whose text or context states the answer teach the scorer to keep
    what the policy deletes. the generator produces a few per run despite the prompt."""
    kept = []
    for r in records:
        texts = [r.text] + [c["text"] for c in r.context]
        if r.label != Label.DIRECT and any(contains_answer(t, r.answer) for t in texts):
            print(f"dropped {r.label}/{r.style} for {r.answer}: {r.text!r}")
            continue
        kept.append(r)
    return kept


def estimate(client: anthropic.Anthropic, cfg: Config, jobs: list[tuple[str, str]]) -> float:
    """usd for the whole run, from one real token count and a guessed output length."""
    word, template = jobs[0]
    prompt = build_prompt(cfg, word, template)
    counted = client.messages.count_tokens(
        model=cfg.model, system=prompt.system, messages=prompt.messages
    )
    n_single = cfg.n_direct + cfg.n_strong + cfg.n_weak + cfg.n_benign
    n_multi = cfg.n_multi_direct + cfg.n_multi_strong + cfg.n_multi_benign
    output_guess = 45 * n_single + 120 * n_multi
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
        assert response.stop_reason == "end_turn", f"{word}/{template}: {response.stop_reason}"
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
        assert message.stop_reason == "end_turn", f"{result.custom_id}: {message.stop_reason}"
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
    records = drop_mislabeled(records)
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    out = cfg.out_dir / f"{date.today().isoformat()}-{cfg.name}.jsonl"
    out.write_text("".join(r.to_json() + "\n" for r in records))
    print(f"wrote {len(records)} records to {out}")
    return out


if __name__ == "__main__":
    main(tyro.cli(Config))
