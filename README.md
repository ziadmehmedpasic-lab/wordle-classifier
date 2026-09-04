# Wordle Classifier

Deletes anything in any text channel that gives away today's Wordle answer, including in screenshots, voice messages and videos.

## How it works

Swiss-cheese defense: every layer has holes, and the layers are chosen so the holes do not line up. A spoiler has to get through all of them.

**Inputs become text.** Message text, embeds, link previews, polls, stickers, file names, reactions and names are collected as-is. Images go through OCR. Voice messages, audio files and video soundtracks go through speech-to-text. Everything below runs on the result, so a trick typed into a screenshot meets the same rules as the typed version.

| layer | what it is | catches | its holes |
|---|---|---|---|
| 1. Pattern detector | `detector.js`, deterministic, no network | the answer's letters present in any disguise: leetspeak, separators, look-alike glyphs, encodings, acrostics, capitals, spoken letters, fragments across messages | meaning. It cannot see "rhymes with pager" or "the German is Wette" |
| 2. Fine-tuned classifier | small LLM trained on generated examples, conditioned on the day's answer and the last few messages (in progress, see `ml/`) | hints, definitions, rhymes, translations, letter clues, build-ups spread across several messages | disguises it has never seen, and calibration at the margin between a weak hint and chat |
| 3. Claude judge | `llm.js`, hosted model with the same policy labels | the same as layer 2 with a larger model; also reads images when OCR finds nothing | cost and latency, so it runs only on suspicious traffic |

Layer 1 deletes on its own only when the match is definite. Fuzzy matches (phonetic, anagram, typo, the answer straddling a word boundary) are passed to the later layers as evidence rather than acted on, per `POLICY.md`. The layer split for the detector and the classifier hookup are being landed PR by PR; today the bot runs layer 1 with every rule as a hard delete, then layer 3.

**Operational layer.** Nothing is deleted on an error path: a scorer timeout, an API failure or an OCR failure keeps the message and logs it. Planned alongside the classifier: a mod log channel with a restore reaction, a runtime kill switch, and a dry-run mode.

What counts as a spoiler, which labels exist, and what gets deleted is defined once in `POLICY.md`; the detector, the judge, the classifier, the training data and the evaluation all follow it.

## How it finds the answer
Fetches the official New York Times endpoint every 15 minutes:
`https://www.nytimes.com/svc/wordle/v2/YYYY-MM-DD.json`
Bans today's word, plus yesterday's and tomorrow's (covers timezones). `POLICY.md` moves this to today's word only in a configured timezone; that change lands with the bot operations PR.

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
- `index.js` — Discord wiring: messages, edits, attachments, OCR, speech-to-text, reactions, names
- `ml/` — layer 2: data generation, training, evaluation and serving for the fine-tuned classifier (Python, `uv`); see `ml/pyproject.toml`
- `test/detector.test.js` — 132 targeted cases + generic sweep + false-positive sweep
- `test/attacks.json`, `test/attacks_open.json`, `test/ATTACKS.md` — red-team ledger: attacks the detector must catch, and known gaps
- `test/eval_data.js` — runs the generated ml data through the detector (recall per style, false positives)
- `test/audio.unit.test.js` — offline audio checks; `test/audio.test.js` — live transcription of synthesised clips

## Layer 1: what the pattern detector catches
| Technique | Example (answer: wager) |
|---|---|
| Plain, caps, punctuation, hashtags | `WAGER!!`, `#wager` |
| Discord markdown | `**wager**`, `\|\|wager\|\|`, `` `wager` ``, code blocks, headers, subtext, quotes, lists, masked links, per-letter links |
| Leetspeak and symbol swaps | `W8g3r`, `w@ger`, `wa*er`, `l19h7`, math-bold digits `w𝟖g𝟑r` |
| Separators and brackets | `w.a.g.e.r`, `w-a-g-e-r`, `w[a]ger`, any symbol `w·a·g·e·r`, `w?a?g?e?r`, emoji `w🔥a🔥g🔥e🔥r`, custom emoji between letters |
| Spaced or split words | `w a g e r`, `wa ger`, `w 8 g 3 r`, `wa lol ger`, spaced Caesar `b f l j w` |
| Letters with filler words | `w then a then g then e then r`, `w for whiskey a for apple ...`, `w1 a2 g3 e4 r5`, `"w" and "a" and ...` |
| Glued to other letters | `wagerbros`, `prowager`, `itswager`, `xxwagerxx` (non-dictionary tokens only) |
| Across word boundaries | `saw a german`, `help lane` (for plane) |
| Capitals inside a sentence | `hoWie sAid the biG onE was Right`, `#WeAllGetEmRight` |
| Lines, columns, diagonals | first letter of each line, letters down a column or diagonal of a code block |
| Look-alike letters | Cyrillic/Greek, fullwidth `ｗａｇｅｒ`, small caps `ᴡᴀɢᴇʀ`, 🇼🇦🇬🇪🇷, 🅦🅐🅖🅔🅡, 𝐰𝐚𝐠𝐞𝐫, braille `⠺⠁⠛⠑⠗`, "fancy font" glyphs `山卂Ꮆ乇尺`, IPA, full Unicode confusables table |
| Look-alike letter pairs | `vvager`, `rnoat`, `cloor` |
| Invisible / control characters | zero-width spaces, right-to-left override, zalgo combining marks |
| Upside-down text | `ɹǝƃɐʍ`, spaced `ɹ ǝ ƃ ɐ ʍ` |
| Encodings | reversed (with suffix `sregaw`), rot13, any Caesar shift, atbash, base64 (any plaintext), base32, hex (`77 61 ...`, `0x7761...`, `\x77`), octal, binary, a=1..z=26 and a=0..z=25 with any separator or number words, ASCII codes, URL-encoding, HTML entities, `U+0077`, `%u0077`, phone keypad `92437`, pig latin `agerway`, keyboard shift `eshrt`, morse in any glyphs or spoken `dit dah` |
| Spoken letters | NATO `whiskey alpha golf echo romeo`, letter names `double u ay gee ee ar`, Spanish and German letter names |
| Edit instructions | `its wage but add an r`, `planet without the t` (near-miss dictionary word plus an instruction naming a letter) |
| Stretched / doubled | `waaaager`, `wwaaggeerr`, `waager` |
| Suffixes | `wagers`, `wagered`, `wagering` |
| Typos, anagrams, vowel removal, interleaving | `wgaer`, `wsger`, `wagr`, `wgr`, `wxaxgxexr`, reversed `rxexgxaxw` (non-dictionary words only) |
| Phonetic spellings | `wayjer`, `waygur` (non-dictionary words only) |
| Acrostics | `wife angle grey ear red`, `wage and real`, reversed initials, emoji names 🐳🍎🦒🥚🌈 with one distractor, emoji mixed with letters `w 🍎 g e r` |
| Hidden in other content | URLs, custom emoji names, file names, embeds, link previews, polls, stickers, forwarded messages |
| Attachments | `.txt`/`.md`/`.csv` contents, and **screenshots via OCR** |
| Speech | Discord **voice messages**, uploaded audio (`mp3/ogg/wav/m4a/flac/webm`) and the soundtrack of uploaded videos (`mp4/mov/webm`) are transcribed, then run through every text check and the LLM layer |
| Fragments across messages | `w` `a` `g` `e` `r` or `wa` `ger` as separate messages (all deleted) |
| Edits and link previews | messages re-scanned on edit and when embeds resolve |
| Reactions | 🇼🇦🇬🇪🇷 reactions spelling the word are removed |
| Names | nicknames, thread/forum titles, channel names, role names, new emoji/sticker names |
| Webhooks and other bots | scanned too (only the bot's own warnings are skipped) |
| Offline gap | last 50 messages per channel scanned at startup |

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

## Layer 2: fine-tuned classifier (in progress)
Lives in `ml/`. Labeled examples are generated per past answer with Claude across the policy's four levels and
dozens of disguise and hint styles, including exchanges of several messages where only the final one spoils.
A small model is fine-tuned on `(answer, recent messages, message) -> label`, calibrated, and served over HTTP
for the bot to call before layer 3. Progress and the remaining steps are tracked in the PRs.

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
