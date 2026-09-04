# Wordle Classifier

Deletes anything in any text channel that gives away today's Wordle answer, including in screenshots, voice messages and videos.

## How it finds the answer
Fetches the official New York Times endpoint every 15 minutes:
`https://www.nytimes.com/svc/wordle/v2/YYYY-MM-DD.json`
Bans today's word, plus yesterday's and tomorrow's (covers timezones).

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
- `detector.js` — pure text detection logic (no Discord dependency)
- `llm.js` — Claude-based meaning classifier (hints, riddles, translations, images)
- `audio.js` — speech-to-text for voice messages, audio files and video soundtracks (OpenAI)
- `index.js` — Discord wiring: messages, edits, attachments, OCR, speech-to-text, reactions, names
- `test/detector.test.js` — 132 targeted cases + generic sweep + false-positive sweep
- `test/audio.unit.test.js` — offline audio checks; `test/audio.test.js` — live transcription of synthesised clips

## What it catches
| Technique | Example (answer: wager) |
|---|---|
| Plain, caps, punctuation, hashtags | `WAGER!!`, `#wager` |
| Discord markdown | `**wager**`, `\|\|wager\|\|`, `` `wager` ``, code blocks, headers, subtext, quotes, masked links |
| Leetspeak and symbol swaps | `W8g3r`, `w@ger`, `wa*er`, `l19h7` |
| Separators and brackets | `w.a.g.e.r`, `w-a-g-e-r`, `w[a]ger` |
| Spaced or split words | `w a g e r`, `wa ger`, `w 8 g 3 r` |
| Look-alike letters | Cyrillic/Greek, fullwidth `ｗａｇｅｒ`, small caps `ᴡᴀɢᴇʀ`, 🇼🇦🇬🇪🇷, 🅦🅐🅖🅔🅡, 𝐰𝐚𝐠𝐞𝐫, full Unicode confusables table |
| Look-alike letter pairs | `vvager`, `rnoat`, `cloor` |
| Invisible / control characters | zero-width spaces, right-to-left override, zalgo combining marks |
| Upside-down text | `ɹǝƃɐʍ` |
| Encodings | reversed, rot13, any Caesar shift, atbash, base64, hex, binary, a=1..z=26, ASCII codes, URL-encoding, HTML entities, morse |
| Spoken letters | NATO `whiskey alpha golf echo romeo`, letter names `double-u ay gee ee ar` |
| Stretched / doubled | `waaaager`, `wwaaggeerr`, `waager` |
| Suffixes | `wagers`, `wagered`, `wagering` |
| Typos, anagrams, vowel removal, interleaving | `wgaer`, `wsger`, `wagr`, `wgr`, `wxaxgxexr` (non-dictionary words only) |
| Phonetic spellings | `wayjer`, `waygur` (non-dictionary words only) |
| Acrostics | `wife angle grey ear red`, `wage and real`, emoji names 🐳🍎🦒🥚🌈 |
| Hidden in other content | URLs, custom emoji names, file names, embeds, link previews, polls, stickers, forwarded messages |
| Attachments | `.txt`/`.md`/`.csv` contents, and **screenshots via OCR** |
| Speech | Discord **voice messages**, uploaded audio (`mp3/ogg/wav/m4a/flac/webm`) and the soundtrack of uploaded videos (`mp4/mov/webm`) are transcribed, then run through every text check and the LLM layer |
| Fragments across messages | `w` `a` `g` `e` `r` or `wa` `ger` as separate messages (all deleted) |
| Edits and link previews | messages re-scanned on edit and when embeds resolve |
| Reactions | 🇼🇦🇬🇪🇷 reactions spelling the word are removed |
| Names | nicknames, thread/forum titles, channel names, role names, new emoji/sticker names |
| Webhooks and other bots | scanned too (only the bot's own warnings are skipped) |
| Offline gap | last 50 messages per channel scanned at startup |

## LLM layer (optional, recommended)
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

## Audio layer (optional)
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
