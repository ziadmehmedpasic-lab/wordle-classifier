# Moderation policy

This file is the single definition of what the bot removes. The detector, the Claude judge,
the trained scorer, human labelers and the evaluation all use the labels below. Change the
policy here first, then the code.

## Labels

| label | meaning | example (answer WAGER) | action |
|---|---|---|---|
| `direct` | the answer itself, in any disguise or encoding, or an image showing it | `w8g3r`, `wife angle grey ear red`, a screenshot of the solved grid | delete |
| `strong_hint` | pins the answer down for a solver without stating it | "rhymes with pager", "W _ G _ R", "the German is Wette" | delete |
| `weak_hint` | narrows the answer but other words still fit | "something you do at a casino", "starts with W" | delete |
| `benign` | carries no information about the answer | "got it in 3, brutal one", a share grid of coloured squares | keep |

Ordinary use of the answer word in an unrelated sentence counts as `direct`. On a day the
answer is a common word (`house`, `light`, `today`) normal sentences will be removed; this is
accepted. The answer's letters merely running across a word boundary ("who used" on a HOUSE
day, "help lane" on a PLANE day) is not `direct`: it is indistinguishable from accidental
text, so it is never generated as a spoiler example and the detector treats it as
`suspicious` at most.

## Deletion

- All three non-benign levels are deleted immediately. There is no shadow period on the
  live server; the playground round before install is the calibration step.
- Every deletion is posted to the mod log channel with the message content, level, the
  detector tier and kind, and the scorer's score. A restore reaction on that post reposts
  the message under the author's name and records a false positive.
- The public notice to the author is generic: it says the message looked like a Wordle
  spoiler and was removed, and that mods can restore it. It never repeats the answer and
  never names the rule that fired.
- Any inference failure (scorer timeout, API error, OCR failure) keeps the message and logs
  the failure. Nothing is deleted on an error path.
- An admin command drops the bot to log-only at runtime; `DRY_RUN=true` does the same at
  startup.

## Which answers are protected

Today's answer only, where "today" is computed in the configured server timezone
(`TIMEZONE`). `ANSWER_WINDOW_DAYS` widens this to also protect the previous N days for
late-night players in other timezones; the default is 0. Yesterday's answer is fair game once
the day rolls over. Tomorrow's answer is never fetched.

## Detector confidence tiers

The pattern detector reports one of two tiers.

- `definite`: the answer is literally present after reversible transformations (unicode
  look-alikes, invisible characters, markdown, leetspeak with letters in position, bounded
  separators, exact encodings, initials-only acrostics). Deleted without consulting the
  scorer.
- `suspicious`: the text could be the answer under a lossy transformation (phonetic match,
  one-edit typo, anagram, any Caesar shift, acrostics with fillers). Never deleted on its
  own; passed to the scorer as evidence.

## Consent and data

- Members are told that message text, and images posted as attachments, may be sent to
  Anthropic's API and to the project's own scorer endpoint for classification.
- The bot stores nothing about benign messages. Deleted messages live in the mod log.
- A one-off export of channel history for measuring the false-deletion rate happens only
  with the server's agreement, stays on the maintainers' machines, is never committed, and
  the raw export is deleted once labels exist.
- Playground probes are stored with the tester's declared intent and are used as training
  and evaluation data.

## Acceptance set

`ml/data/acceptance.jsonl` is a small human-labeled set used to benchmark every classifier
option and to fix the deployment threshold. It is frozen before any model work. The current
file is a draft written by the maintainers; entries marked `"source": "draft"` still need a
second person's adjudication before the set counts as frozen.

Fields: `id`, `answer`, `text`, `label`, `style`, `source`. Style names: `plain`, `leet`,
`separators`, `unicode`, `emoji`, `encoding`, `acrostic`, `capitalization`, `definition`,
`synonym`, `rhyme`, `positional`, `translation`, `crossword`, `rebus`, `category`,
`wordle_chat`, `chat`, `hard_benign`.

## Threshold

The scorer threshold is fixed on the frozen acceptance set and the playground's final
frozen round at the false-deletion rate the maintainers accept. Record the chosen value and
the measured rate here when set.

- threshold: unset
- measured false deletions per 10k benign messages: unmeasured
