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
- Inspection distinguishes `clean`, `spoiler`, and `unscanned`. Unsupported content,
  exceeded limits, disabled required layers and processing failures are reported as
  `unscanned`, never as a successful clean scan. Positive spoiler evidence from another
  successfully inspected part can still remove the message.
- Captions, forwarded content, attachments, OCR and transcripts are judged together.
  Other bots and webhooks receive the same checks as members; only this bot's own messages
  are excluded.
- An admin command drops the bot to log-only at runtime; `DRY_RUN=true` does the same at
  startup.

## Which answers are protected

Today's answer only, where "today" is computed in the configured server timezone
(`TIMEZONE`, default UTC). `ANSWER_WINDOW_DAYS` widens this to also protect the previous N days (0-31) for
late-night players in other timezones; the default is 0. Yesterday's answer is fair game once
the day rolls over. Tomorrow's answer is never fetched.

If the current date's answer cannot be fetched and validated, moderation is suspended rather
than using an answer from outside that window. Failed fetches retry after one minute.

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

- When enabled, status/activity text and available profile avatars/banners are inspected
  using the same layers as messages. Members must be informed of this coverage. Statuses,
  account images and inaccessible profile fields cannot be cleared by the bot; findings
  require moderator action. Timeout alone does not remove those fields.
- Server channel topics/tags, event descriptions/images, role icons and emoji/sticker
  images are inspected on changes and answer rollover. Confirmed spoilers are cleared
  only when the bot has the necessary permissions; otherwise moderators are alerted.
- Surface alerts contain generic outcomes and resource IDs, never spoiler text or images.
- Bounded recent conversation is held in process memory for ten minutes (up to 24 messages
  per channel, 4,000 characters each) to detect coordinated clues. Edits replace the old
  content and deletions remove it. Nothing from this context buffer is persisted.

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

Fields: `id`, `answer`, `text`, `label`, `style`, `source`, plus `detector_hit`, a derived field
stamped by `node test/eval_data.js --write` that says whether layer 1 deletes the message before
any classifier runs; the classifier is benchmarked and thresholded on the records where it is
false. Style names: `plain`, `leet`,
`separators`, `unicode`, `emoji`, `encoding`, `acrostic`, `capitalization`, `definition`,
`synonym`, `rhyme`, `positional`, `translation`, `crossword`, `rebus`, `category`,
`wordle_chat`, `chat`, `hard_benign`.

## Threshold

The scorer threshold is fixed on the frozen acceptance set and the playground's final
frozen round at the false-deletion rate the maintainers accept. Record the chosen value and
the measured rate here when set.

- threshold: unset
- measured false deletions per 10k benign messages: unmeasured
