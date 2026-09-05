# Adversarial evaluation

Run `npm run eval:attacks` for real OCR, document/media decoding, pattern checks and
conversation matching. The judge is disabled unless `--live-judge` is passed. There are
no canned OCR transcripts or judge verdicts. Cases protect the synthetic answer `wager`
unless their manifest entry specifies another `answer`; runs never fetch today's
answer or send Discord messages.

`npm run eval:attacks -- --live-judge --prices eval/prices/2026-09-05-opus-5.json`
uses the configured Anthropic credentials/model and measures API requests. The default
request cap is 40 (`--max-requests`). Prices are an explicit dated input; use a matching
price file when changing models. Usage is recorded for every API response, including
refusals and earlier image batches. Missing usage or an unpriced fallback model makes
cost unknown (`null`), never zero. Cost is an estimate from standard token rates, not an
invoice. This corpus has no speech and does not measure transcription cost.

The default output is `eval/runs/<timestamp>/`; use `--out <directory>` to choose a path.
Each run saves generated assets, the manifest, configuration, per-case results, latency,
token usage and summary JSON. `--cases <file>` selects another manifest. Keep independent
cases in separate channels so one Wordle mention does not warm up unrelated test cases.

Fixture bytes pass through the download validator via a local transport, then the same
`extractAsset` and `inspectMessage` functions as the bot. Split-message decisions use
`Conversation`. Removal IDs are predicted actions; Discord permissions, Gateway events,
deletion latency and notification exposure require the separate live playground check.
Cases labeled benign have an empty `remove` list. A wrong contributor removed from an
attack case is also a false deletion. A spoiler retained because of a cap, error or
disabled layer still counts as a miss; `incomplete` additionally identifies such scans.

The fixed corpus is a regression sample, not an estimate of real-server accuracy. Keep
newly discovered misses in the manifest when improving coverage. Normal tests validate
metric accounting and actual fixture frame boundaries; the full OCR/API evaluation is
an explicit command. CI runs the real Tesseract regression tests too, without API keys
or vision model calls.

## Noisy images

`eval/noisy-images.json` contains the four supplied images, JPEG copies and benign
controls. The answers are fixed test values, including `soupy` for the gray-text image.
Cases with unrelated words deliberately protect a different answer. The runner records
the actual OCR transcript separately from the final decision, so an accidental fuzzy
match cannot be mistaken for correct transcription.

```sh
npm run eval:attacks -- --cases eval/noisy-images.json
LLM_MODEL=claude-sonnet-5 npm run eval:attacks -- --cases eval/noisy-images.json --live-judge --prices eval/prices/2026-09-05-sonnet-5.json --max-requests 13
```

Add `--vision-only` to a live run to bypass OCR and measure the vision layer separately.
For Haiku, use `LLM_MODEL=claude-haiku-4-5-20251001` and
`eval/prices/2026-09-05-haiku-4-5.json`. Haiku omits the unsupported effort parameter.
Requests stay on the selected model; they do not automatically fall back to another.

The OCR preprocessing uses pixel statistics, never the protected answer. It tries up
to 13 variants within the existing 30-second recognition budget, skips duplicate
passes, and caps each processed dimension at 1640 pixels including borders. Median
filtering and connected-component cleanup help with background specks and JPEG noise.
Passes below Tesseract confidence 50 do not feed the broad text heuristics; this score
is a filter, not a calibrated probability of correctness. Original pixels remain
available to the vision judge even when OCR returns no useful text.

Crossed-line handwriting remains an OCR miss. Haiku also missed it and falsely linked
an unrelated word to the protected answer in the integrated tests. Do not count all
images with empty OCR as safe or assume a high judge confidence is reliable.

On 2026-09-05, the final OCR + Sonnet 5 run caught all eight attack cases and kept all
five benign controls. It made seven API calls with an estimated token cost of $0.009866.
Sonnet received original images, without line-removal copies. This is a small regression
set, not a guarantee for other handwriting, noise patterns or future model responses.

`npm run eval:overload` submits 24 image inspections together, using real OCR with the
judge disabled, and checks direct text during saturation. It saves queue rejections,
queue expiry, per-request latency and the direct-text result to `eval/runs/overload.json`.
This is a bounded local burst measurement, not a Discord throughput guarantee.

QR fixtures exercise literal payload decoding as well as the judge's interpretation.
QR decoding examines the full image and overlapping halves on light/dark backgrounds,
scaled within 1024 pixels, with at most eight located codes per region. The original
image still reaches OCR and vision. General barcode
formats, overlapping/unlocatable codes and dense codes lost during scaling remain gaps.
Text subtitles are extracted from up to eight tracks (200 kB and 15 seconds per track).
Bitmap subtitle codecs remain explicitly unscanned.

## Live Discord playground

Use a dedicated test server, a moderator bot token in local `.env`, and supplied test
guild/channel IDs. Enable the required intents and ensure the bot is scoped to that
server before starting it. Do not run the production startup sweep for this experiment.
The current offline runner does not log into Discord or override a live bot's answer.

Record the bot commit, configured layers/intents, permissions and each test resource ID.
Use synthetic content to exercise: message creation and edits; image/file/video uploads;
cross-author fragments; reaction images; channel topics; custom statuses; profile images;
and missing Manage Messages/Manage Channels permissions. Verify both actual removal (or
moderator alert for profiles/statuses) and preservation of benign controls. Record which
checks could not run. Clean up only resources created for the test. Profile/presence
updates must come from a consenting test account; do not automate a normal user token.
