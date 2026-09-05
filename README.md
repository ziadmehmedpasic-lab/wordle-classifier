# Wordle Classifier

A Discord bot for removing Wordle spoilers from messages, attachments and server fields.
It combines text rules, OCR and an optional Claude judge. Audio transcription is optional
too. The classifier training code in `ml/` is separate from the running bot.

This is an experiment. Detection has gaps and false positives; ordinary sentences containing
the answer are removed as well. [POLICY.md](POLICY.md) describes the moderation policy.

## Run the bot

Requires Node.js 22 or newer and a Discord bot token.

1. Create a bot in the [Discord developer portal](https://discord.com/developers/applications).
   Enable Message Content Intent. Enable Server Members Intent if nickname or profile
   checks are on, and Presence Intent if status checks are on.
2. Invite it with View Channels, Send Messages, Read Message History and Manage Messages.
   Add Manage Nicknames, Manage Channels, Manage Roles, Manage Expressions, Manage Events
   and Moderate Members for the corresponding moderation features. Place its role above
   members it should be able to rename or time out.
3. Install dependencies and create the local configuration:

   ```sh
   npm ci
   cp .env.example .env
   ```

4. Set `DISCORD_TOKEN` and your server's `TIMEZONE` in `.env`, then run `npm start`.

The bot fetches the answer from the NYT endpoint for the date in `TIMEZONE` (UTC by
default). `ANSWER_WINDOW_DAYS` adds up to 31 previous days; the default is 0. It never
fetches tomorrow. If the current answer is unavailable, moderation waits for a successful
fetch instead of using an expired answer.

Useful settings in [.env.example](.env.example):

| Setting | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enable the judge for hints and visual evidence that text rules miss. |
| `LLM_MODEL` | Choose the Claude model explicitly. No automatic model substitution. Haiku is supported, but missed crossed-line handwriting in our image tests; see the evaluation notes. |
| `LLM_MODE` | `suspicious` by default; `all` checks every message and `off` disables the judge. Attachments trigger judge checks in suspicious mode. |
| `OPENAI_API_KEY` | Enable transcription of voice messages, audio files and video soundtracks. |
| `POLICE_PROFILES`, `POLICE_PRESENCES` | Opt into available profile images/account names and status/activity text. Both default off. |
| `MOD_LOG_CHANNEL_ID` | Send moderator alerts, including aggregated incomplete scans. |
| `ALLOWED_CHANNEL_IDS` | Exempt selected channels from moderation. |
| `SCAN_BACKLOG` | Check the latest 50 messages per channel at startup; defaults on. |
| `CATCH_SCRIPTS` | Match answer spellings in other scripts. Defaults on; disable it if it causes false deletions in multilingual chat. |

When enabled, the judge receives message text and images through Anthropic's API, and
transcription sends audio to OpenAI. Tell server members which features are enabled.

## What it checks

- Message text, edits, forwarded content, embeds, polls, component text and attachment
  metadata. Other bots and webhooks are checked too.
- Images and QR payloads; UTF-8/UTF-16 text; rendered PDFs; ZIP contents, including Office
  XML and embedded images. File bytes determine the format, rather than the extension.
- GIF/video frames, text subtitle tracks and, with transcription enabled, audio.
- Custom emoji and sticker images, reactions, member display names, channel names/topics,
  forum tags, roles, scheduled events, stages and voice-channel statuses.

Short fragments can be joined across authors within three minutes; only contributing
messages are removed. The judge gets up to 24 recent messages from the last ten minutes.
That context stays in memory and is updated on edits, deletions and answer changes.

OCR tries text-block layout, color masks and speck removal before the existing rotation
passes. Low-confidence OCR text is discarded; the original image still reaches the
vision judge. Handwriting and text covered by crossing lines can defeat OCR.

Profiles and statuses require moderator action because the bot cannot edit another
account. Other server fields are cleared only when the bot has permission.

## Limits

Unsupported content, failed processing and exceeded limits produce an `unscanned` result.
They are logged and can trigger a moderator alert; they do not cause deletion. A confirmed
spoiler found in another part of the same message can still be removed.

The main limits are 32 MB per download/expanded archive, 64 archive entries, two nested
archive levels, ten rendered pages/images, and 300 video frames or 120 seconds. Two slow
inspections run at once, with 16 waiting slots and a 30-second queue wait. Content beyond
those limits can get through.

Other gaps include external webpages, Office layout-only clues, encrypted files, bitmap
subtitles, additional audio/video tracks, non-QR barcodes, Lottie stickers, unavailable
account fields and live voice chat. Deleting a message cannot undo a spoiler someone
already saw or received in a notification.

Restore reactions and a runtime log-only command are described in the policy but are not
implemented in the bot yet.

## Tests and experiments

```sh
npm test                 # regression tests; no API keys needed
npm run test:ocr         # real Tesseract checks
npm run eval:attacks     # synthetic attacks through the inspection pipeline
npm run eval:overload    # a burst of concurrent image scans
```

The attack evaluation saves fixtures, missed spoilers, false deletions, incomplete scans
and latency. It uses a fixed fake answer. Add `--live-judge` to exercise the API; see
[eval/README.md](eval/README.md) for pricing inputs, saved results and the Discord test
protocol. OCR language data may download on its first run.

The [browser playground](https://wordle-classifier.vercel.app) tests the text detector
against random target words. It does not run the bot's OCR, judge or transcription.
Build and hosting notes are in [web/README.md](web/README.md).

The [ML experiments](ml/README.md) cover dataset generation, training and evaluation.
Known text attacks are tracked in [test/ATTACKS.md](test/ATTACKS.md).
