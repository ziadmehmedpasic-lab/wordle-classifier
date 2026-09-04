"""claude judge: labels text or images against the policy. used for pre-labeling data and as
a hosted baseline in the benchmark, never as ground truth."""

import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import anthropic

from spoiler.labels import Label

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
DEFAULT_MODEL = "claude-opus-5"

VERDICT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["label", "confidence", "reason"],
    "properties": {
        "label": {"type": "string", "enum": [label.value for label in Label]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string"},
    },
}

ImageMediaType = Literal["image/png", "image/jpeg", "image/webp", "image/gif"]


@dataclass(frozen=True)
class Evidence:
    """a suspicious-tier detector hit, passed to the judge as a pointer, not proof."""

    kind: str
    candidate: str


@dataclass(frozen=True)
class Verdict:
    label: Label
    confidence: float
    reason: str
    refused: bool = False
    input_tokens: int = 0
    output_tokens: int = 0


def _system(prompt_name: str, answers: list[str]) -> list[anthropic.types.TextBlockParam]:
    assert answers, "judge needs at least one protected answer"
    prompt = (PROMPTS_DIR / prompt_name).read_text()
    protected = ", ".join(a.upper() for a in answers)
    return [
        {"type": "text", "text": prompt, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": f"Protected answers: {protected}."},
    ]


def _call(
    client: anthropic.Anthropic,
    system: list[anthropic.types.TextBlockParam],
    content: list[anthropic.types.ContentBlockParam],
    model: str,
) -> Verdict:
    response = client.messages.create(
        model=model,
        max_tokens=400,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={
            "effort": "low",
            "format": {"type": "json_schema", "schema": VERDICT_SCHEMA},
        },
    )
    usage = response.usage
    if response.stop_reason == "refusal":
        return Verdict(
            Label.BENIGN,
            0.0,
            "model refused",
            refused=True,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
    text = next(block.text for block in response.content if block.type == "text")
    data = json.loads(text)
    return Verdict(
        label=Label(data["label"]),
        confidence=float(data["confidence"]),
        reason=data["reason"],
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )


def judge_text(
    client: anthropic.Anthropic,
    answers: list[str],
    text: str,
    context: list[tuple[str, str]] | None = None,
    evidence: list[Evidence] | None = None,
    model: str = DEFAULT_MODEL,
) -> Verdict:
    """context is (author, text) pairs, oldest first."""
    parts: list[str] = []
    if context:
        lines = "\n".join(f"- {author}: {body}" for author, body in context)
        parts.append(f"Recent messages in this channel, oldest first:\n{lines}")
    if evidence:
        lines = "\n".join(f"- {e.kind}: {e.candidate!r}" for e in evidence)
        parts.append(f"Detector evidence (suspicious tier, not proof):\n{lines}")
    parts.append(f"Message to judge:\n{text}")
    body = "\n\n".join(parts)
    content: list[anthropic.types.ContentBlockParam] = [{"type": "text", "text": body}]
    return _call(client, _system("judge.md", answers), content, model)


def judge_image(
    client: anthropic.Anthropic,
    answers: list[str],
    image: bytes,
    media_type: ImageMediaType,
    caption: str = "",
    model: str = DEFAULT_MODEL,
) -> Verdict:
    data = base64.standard_b64encode(image).decode("ascii")
    content: list[anthropic.types.ContentBlockParam] = [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
        {"type": "text", "text": f"Message text accompanying the image: {caption or '(none)'}"},
    ]
    return _call(client, _system("judge_image.md", answers), content, model)
