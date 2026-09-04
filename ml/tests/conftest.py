"""a two-layer olmo2 causal lm (that model type keeps the generic tokenizer) with a word-level
tokenizer over the scorer prompt vocabulary, saved to disk so the real from_pretrained paths run
on cpu in seconds."""

import re
from pathlib import Path

import pytest
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import Olmo2Config, Olmo2ForCausalLM, PreTrainedTokenizerFast

from spoiler.labels import Label
from spoiler.scorer import PROMPTS_DIR

CHAT_TEMPLATE = (
    "{% for m in messages %}<im_start> {{ m['role'] }} {{ m['content'] }} <im_end> {% endfor %}"
    "{% if add_generation_prompt %}<im_start> assistant {% endif %}"
)
EXTRA_WORDS = "wager crane plane house rhymes with pager today lol bob amy - : WAGER CRANE".split()


@pytest.fixture(scope="session")
def fake_model_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    prompt_words = re.findall(r"\S+", (PROMPTS_DIR / "scorer.md").read_text())
    words = ["<pad>", "<unk>", "<eos>", "<im_start>", "<im_end>", "user", "assistant"]
    words += [label.value for label in Label]
    for w in prompt_words + EXTRA_WORDS:
        if w not in words:
            words.append(w)
    tok = Tokenizer(models.WordLevel({w: i for i, w in enumerate(words)}, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=tok, pad_token="<pad>", unk_token="<unk>", eos_token="<eos>"
    )
    tokenizer.chat_template = CHAT_TEMPLATE
    config = Olmo2Config(
        vocab_size=len(words),
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=2,
        num_key_value_heads=2,
        max_position_embeddings=512,
        pad_token_id=0,
        eos_token_id=2,
    )
    out = tmp_path_factory.mktemp("fake-model")
    tokenizer.save_pretrained(out)
    Olmo2ForCausalLM(config).save_pretrained(out)
    return out
