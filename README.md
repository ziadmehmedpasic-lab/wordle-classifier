# Wordle Classifier

Deletes anything in any text channel that gives away today's Wordle answer, including in screenshots, voice messages and videos.

## How it works

Swiss-cheese defense. Each layer has holes; they don't line up.

Everything is turned into text first: message content, embeds, polls, names, reactions; images via OCR; voice, audio and video via speech-to-text.

| layer | catches | misses |
|---|---|---|
| 1. Pattern detector (`detector.js`) | the answer's letters in any disguise | meaning |
| 2. Fine-tuned classifier (`ml/`, in progress) | hints, definitions, translations, build-ups across messages | unseen disguises |
| 3. Claude judge (`llm.js`) | same as 2, bigger model; images OCR can't read | cost, so only on suspicious traffic |

Errors never delete. Labels and what gets deleted are defined in `POLICY.md`.

## How it finds the answer
Fetches the official New York Times endpoint every 15 minutes:
`https://www.nytimes.com/svc/wordle/v2/YYYY-MM-DD.json`
Bans today's word, plus yesterday's and tomorrow's (covers timezones). Moving to today only, see `POLICY.md`.

## Setup
1. https://discord.com/developers/applications -> New Application -> Bot.
2. Bot tab: **Reset Token** (copy it). Enable **Message Content Intent** and **Server Members Intent**.
3. OAuth2 URL Generator: scope `bot`; permissions **View Channels, Send Messages, Manage Messages, Manage Nicknames, Manage Threads, Manage Channels, Manage Roles, Manage Expressions, Add Reactions, Read Message History**.
4. Invite the bot, then:
   ```
   cp .env.example .env      # paste your token into .env
   npm install
   npm start
   ```
5. `npm test` runs the detector test suite.

## Layout
- `POLICY.md` — the moderation policy: labels, what is deleted, which answers are protected, data handling
- `detector.js` — layer 1, pure text detection logic (no Discord dependency)
- `llm.js` — layer 3, Claude-based meaning classifier (hints, riddles, translations, images)
- `audio.js` — speech-to-text for voice messages, audio files and video soundtracks (OpenAI)
- `gifs.js` — Tenor/Giphy tag and description lookup for GIF links
- `frames.js` — ffmpeg frame sampling so OCR covers every frame of a GIF or video
- `index.js` — Discord wiring: messages, edits, attachments, OCR, speech-to-text, reactions, names
- `ml/` — layer 2: data generation, training, evaluation and serving for the fine-tuned classifier (Python, `uv`); see `ml/pyproject.toml`
- `test/detector.test.js` — 132 targeted cases + generic sweep + false-positive sweep
- `test/attacks.json`, `test/attacks_open.json`, `test/ATTACKS.md` — red-team ledger: attacks the detector must catch, and known gaps
- `test/eval_data.js` — runs the generated ml data through the detector (recall per style, false positives); `--write` stamps each record with `detector_hit` so the classifier is scored only on what reaches it
- `test/audio.unit.test.js` — offline audio checks; `test/audio.test.js` — live transcription of synthesised clips
- `test/gifs.test.js` — offline GIF tag checks with a mocked API
- `test/frames.unit.test.js` — offline frame sampling checks (ffmpeg-built fixtures, faked OCR); `test/frames.test.js` — real tesseract over text fixtures
- `web/` — the playground page: `detector.js` bundled for the browser; `api/attempts.js` — its attempt store on Vercel

## Playground

A web page where testers try to leak a random target word past the pattern layer. It shows five tiles, takes a message, runs `scan` in the browser and says whether the bot would have deleted it. Every attempt is stored with the tester's declared intent (leak or innocent), the verdict, and an optional one-line decode note when a leak gets through. Only layer 1 runs there; the judge and scorer are not wired in yet.

    npm run build:web    # web/dist/index.html, one self-contained file

It is hosted on Vercel at https://wordle-classifier.vercel.app: the static page from `web/dist` plus one serverless function, `api/attempts.js`, that keeps attempts in an Upstash Redis store provisioned through the Vercel marketplace (`vercel integration add upstash`; the function reads `KV_REST_API_URL` and `KV_REST_API_TOKEN`). `vercel.json` holds the build settings and `.vercelignore` keeps `ml/` and `test/` out of the upload. Deploy with `npx vercel --prod`.

Targets come from `web/words.json`, a curated list of common five-letter words, all in the detector's dictionary. The NYT answer list never enters the page.

Attempts feed the red-team ledger: `GET /api/attempts` returns the newest 500 as JSON. Move the misses worth catching into `test/attacks_open.json` in its entry shape; the `decode` note maps straight onto the ledger's `decode` field.

## Layer 1: what the pattern detector catches
| Technique | Example (answer: wager) |
|---|---|
| Plain, caps, punctuation, hashtags | `WAGER!!`, `#wager` |
| Discord markdown | `**wager**`, `\|\|wager\|\|`, `` `wager` ``, code blocks, headers, subtext, quotes, lists, masked links, per-letter links |
| Leetspeak and symbol swaps | `W8g3r`, `w@ger`, `wa*er`, `l19h7`, math-bold digits `w𝟖g𝟑r` |
| Separators and brackets | `w.a.g.e.r`, `w-a-g-e-r`, `w[a]ger`, any symbol `w·a·g·e·r`, `w?a?g?e?r`, emoji `w🔥a🔥g🔥e🔥r`, custom emoji between letters |
| Spaced or split words | `w a g e r`, `wa ger`, `w 8 g 3 r`, `wa lol ger`, `wa and then ge and then r`, spaced Caesar `b f l j w` |
| Letters with filler words | `w then a then g then e then r`, `w for whiskey a for apple ...`, `w1 a2 g3 e4 r5`, `"w" and "a" and ...` |
| Glued to other letters | `wagerbros`, `prowager`, `itswager`, `xxwagerxx` (non-dictionary tokens only) |
| Across word boundaries | `saw a german`, `help lane` (for plane) |
| Capitals inside a sentence | `hoWie sAid the biG onE was Right`, `#WeAllGetEmRight`, lowercase inside shouting `HOwIE SaID`, shouted words ignored |
| Marked or styled letters | `ho**w**ie s**a**id the bi**g** on**e** was **r**ight`, `ho𝐰ie s𝐚id`, spoilers, italics, code spans |
| Lines, columns, diagonals | first letter of each line, letters down a column or any diagonal of a code block |
| Look-alike letters | Cyrillic/Greek, fullwidth `ｗａｇｅｒ`, small caps `ᴡᴀɢᴇʀ`, 🇼🇦🇬🇪🇷, 🅦🅐🅖🅔🅡, 𝐰𝐚𝐠𝐞𝐫, braille `⠺⠁⠛⠑⠗`, "fancy font" glyphs `山卂Ꮆ乇尺`, IPA, full Unicode confusables table |
| Look-alike letter pairs | `vvager`, `rnoat`, `cloor` |
| Invisible / control characters | zero-width spaces, right-to-left override, zalgo combining marks |
| Upside-down text | `ɹǝƃɐʍ`, spaced `ɹ ǝ ƃ ɐ ʍ` |
| Encodings | reversed (with suffix `sregaw`), rot13, any Caesar shift (also of `wagers`), atbash, base64 (any plaintext), base32, hex (`77 61 ...`, `0x7761...`, `\x77`), octal, binary, a=1..z=26 and a=0..z=25 with any separator, filler words, number words or ordinals, ASCII codes, URL-encoding, HTML entities, `U+0077`, `%u0077`, phone keypad `92437`, pig latin `agerway`, keyboard shift `eshrt`, morse in any glyphs, emoji, one letter per line, or spoken `dit dah` / `dot dash` |
| Spoken letters | NATO `whiskey alpha golf echo romeo` (also `whiskey then alpha then ...`), letter names `double u ay gee ee ar`, homophones `sea aye owe dub`, Spanish and German letter names |
| Edit instructions | `its wage but add an r`, `planet without the t`, `its crate but the t is an n` (near-miss dictionary word plus the edit letter on its own) |
| Stretched / doubled | `waaaager`, `wwaaggeerr`, `waager` |
| Suffixes | `wagers`, `wagered`, `wagering`, `lighten`, `placement` |
| Typos, anagrams, vowel removal, interleaving | `wgaer`, `wsger`, `wagr`, `wgr`, `wxaxgxexr`, reversed `rxexgxaxw` (non-dictionary words only) |
| Phonetic spellings | `wayjer`, `waygur` (non-dictionary words only) |
| Acrostics | `wife angle grey ear red`, `wage and real`, reversed initials, emoji names 🐳🍎🦒🥚🌈 with one distractor, emoji mixed with letters `w 🍎 g e r` |
| Hidden in other content | URLs, custom emoji names, file names, embeds, link previews, polls, stickers, forwarded messages |
| Attachments | `.txt`/`.md`/`.csv` contents, and **screenshots via OCR** |
| GIF links | Tenor and Giphy URLs: the slug in the link, plus the post's tags, title and description from the provider API (needs `TENOR_API_KEY` / `GIPHY_API_KEY`); the tags also go to the LLM layer |
| GIF and video frames | uploaded GIFs, gif link previews and videos are split into frames with ffmpeg (up to 20 per clip, near-duplicates dropped) and every frame is OCR'd, so text on a later frame or one letter per frame is read. Plain OCR reads only the first frame |
| Speech | Discord **voice messages**, uploaded audio (`mp3/ogg/wav/m4a/flac/webm`) and the soundtrack of uploaded videos (`mp4/mov/webm`) are transcribed, then run through every text check and the LLM layer |
| Fragments across messages | `w` `a` `g` `e` `r` or `wa` `ger` as separate messages (all deleted) |
| Edits and link previews | messages re-scanned on edit and when embeds resolve |
| Reactions | 🇼🇦🇬🇪🇷 reactions spelling the word are removed |
| Names | nicknames, thread/forum titles, channel names, role names, new emoji/sticker names |
| Webhooks and other bots | scanned too (only the bot's own warnings are skipped) |
| Offline gap | last 50 messages per channel scanned at startup |

## Layer 2: fine-tuned classifier (in progress)
Examples are generated per past answer with Claude, a small model is fine-tuned on `(answer, recent messages, message) -> label`, and served over HTTP for the bot. See `ml/`.

Layer 1 deletes before the classifier runs, so the classifier is trained on everything but evaluated and thresholded only on records with `detector_hit: false` (about 2 in 3 generated records, and almost none of the single-message `direct` ones). Run `node test/eval_data.js --write` after generating to stamp that field.

Pipeline, all under `ml/` with `uv run`:
```
python scripts/build_dataset.py                       # answer-grouped train/val/test splits
python scripts/evaluate.py --backend zeroshot         # baseline: Qwen3 label likelihoods, no training
python scripts/evaluate.py --backend claude           # baseline: the Claude judge
python scripts/train.py --name lora                   # LoRA on Qwen3, loss on the label tokens only
python scripts/evaluate.py --backend lora --run-dir runs/<date>-lora \
    --threshold-file data/splits/val.jsonl --max-fp-per-10k 50
```
Every scorer returns a distribution over the four labels; the bot's decision is a threshold on `1 - p(benign)`, picked on the validation split at the false-deletion budget. `evaluate.py` writes `metrics.json` (recall and false deletions per 10k benign with bootstrap intervals, per-label and per-style breakdowns, latency) and a Plotly `dashboard.html` per run. The fine-tune only ships if it beats the best baseline on recall at the accepted false-deletion rate.

## Layer 3: Claude judge (optional, recommended)
Pattern matching cannot judge meaning. With an Anthropic API key in `.env`, messages that pass the pattern layer
are sent to Claude, which returns `spoiler`, `hint`, or `clean` with a confidence and reason. Catches:
- rhymes, synonyms, definitions, riddles ("rhymes with pager", "a gambling term")
- letter clues ("starts with W", "double letter", "same as yesterday but one letter off")
- translations into other languages
- multi-message hints (the last 6 channel messages are sent as context)
- screenshots of solved grids (image sent to the model when OCR finds nothing)

Cost control: by default only Wordle-looking messages are checked, plus every message in a channel for
10 minutes after any Wordle mention. `LLM_MODE=all` checks everything. Roughly $0.003-0.005 per checked
message on Claude Opus 5; the system prompt is cached for an hour to keep repeat cost low.

Run `npm run test:llm` to see live verdicts and per-message cost on 16 sample messages.

## Speech-to-text input (optional)
With an OpenAI API key in `.env`, voice messages, audio files and the soundtrack of video attachments are transcribed
and the transcript goes through the same pattern checks as text, then to the LLM layer (always, not just when the
message looks Wordle-related). Bundled ffmpeg converts each clip to mono 16 kHz opus first, so uploads stay small and
any container works; only the first 10 minutes are transcribed (`AUDIO_MAX_SECONDS`). Roughly $0.006 per minute of
audio on `gpt-4o-transcribe`; each clip logs its length and cost. Transcripts are cached per attachment, so edits do
not pay twice.

Run `npm run test:audio` to transcribe a handful of synthesised clips (spoken answer, spelled letters, NATO alphabet,
hints, clean chat) as both voice-message ogg and mp4. macOS only, it uses `say` to make the clips.

## What it cannot catch
- Live speech in voice channels
- Text shown on screen inside videos (only the soundtrack is transcribed)
- Private DMs between members
- Without the LLM layer: hints, riddles, synonyms, translations
- Without the audio layer: voice messages and audio/video files

## Known trade-offs
- On days the answer is a common word (`house`, `light`, `today`), normal sentences using it are deleted. Inherent to any spoiler filter.
- Acrostic detection can misfire: `star every` on a `stare` day. Disable with `CATCH_ACROSTICS=false`.
- The word-boundary rule misfires on rare collisions: `the mailman` on an `email` day. Measured at 5 extra hits per 73,000 benign message/answer pairs.
- Deliberately not caught by the pattern layer, left to the LLM layer: the answer inside a real word (`delightful` on a `light` day), anagrams and homophones that are real words (`panel`, `plain` for `plane`), acrostics with many filler words, last letters of words. See `test/attacks_open.json`.
