# Adversarial evaluation

Run `npm run eval:attacks` for real OCR, document/media decoding, pattern checks and
conversation matching. The judge is disabled unless `--live-judge` is passed. There are
no canned OCR transcripts or judge verdicts. Every run protects the synthetic answer
`wager`; it never fetches today's answer or sends Discord messages.

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
an explicit command so CI needs neither API credentials nor model calls.

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
