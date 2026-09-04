# Red-team loop for the pattern detector

The pattern layer only ever catches the `direct` label: the answer's letters are literally present in some disguise. Meaning-based hints are the LLM layer's job and are out of scope here.

Ledger files:

- `attacks.json`: attacks the detector must catch. Part of `npm test`. Every rule added to `detector.js` gets its attacks recorded here as regression cases.
- `attacks_open.json`: attacks that get through and have not been fixed, with `worth_catching` and `fp_risk` recorded. The runner flags any that a later change happens to catch so they can be promoted.

Entry shape:

    {"answer": "wager", "text": "...", "technique": "slug", "decode": "how a reader recovers the word", "worth_catching": true, "fp_risk": "what innocent chat a rule would also hit"}

One round:

1. Red team: an agent reads `detector.js` and the README table, invents disguises, verifies each with `scan`, and appends the ones that return null to `attacks_open.json`. A valid attack must be decodable by a reader in the channel without tools, and be something a person would plausibly post.
2. Blue team: pick open techniques worth catching, add a rule to `detector.js` that covers the technique class (not the one example), move the attacks to `attacks.json`, add a generic case to `detector.test.js` where the trick can be templated over any answer.
3. Gates, all of which must hold before a rule lands: `npm test` passes, the chat false-positive sweep in `detector.test.js` gains no new hits, `npm run eval:data` shows no new false positives on the benign records, and `PAIRS=300 npm run eval:data` (every benign record against 300 past answers; needs `ml/data/answers.txt` from `ml/scripts/fetch_answers.py`) stays near its baseline. Round 1 baseline: 175 of 73,440 pairs before, 179 after. A rule that adds more than a handful of pairs is not worth it; the sounds-like-across-tokens rule added 15 and was dropped.
4. Attacks judged not worth catching stay in `attacks_open.json` with `worth_catching: false` and the reason in `fp_risk`. They document the accepted gaps that the LLM layer is expected to cover.

Round log:

- Round 1 (2026-09-04): three red-team agents (unicode and encodings, natural-language embedding, Discord formatting) produced 195 attacks across 112 techniques. 163 are now caught. 30 stay open, 29 of them accepted on purpose. Pilot-data recall on the `direct` label went from 123/150 to 149/150; the `hidden` style (answer across a word boundary) went from 1/15 to 14/15 and `capitalization` from 7/18 to 18/18.
- Round 2 (2026-09-04): one agent attacking the new rules produced 81 attacks across 33 techniques. Biggest gap was letters marked with markdown or a different unicode style inside plain words, which normalisation erased before any rule ran. Also: shouted words breaking the capitals stream, number codes with bullets or filler words, morse per line or in emoji, NATO with connectors, letter-name homophones, edit instructions phrased without a verb, `-en`/`-ment` suffixes, offset diagonals, multi-segment letter-emoji names, more generator alphabets. Two entries were malformed and dropped. Benign pair count 176 after the round (171 with the flagged rules off, boundary rule accounts for the 5).
- Round 3 (2026-09-05): one attack from the real server, `وايجر` (wager in Arabic letters), posted with "found the hack". Fixed as a technique: `translit.js` reads Arabic, Hebrew, Cyrillic, Greek, katakana and hiragana, hangul, Devanagari, Georgian and Armenian back into latin candidates (every letter's plausible spellings, loanword habits such as a trailing ー or 어 for -er, the vowel Japanese and Korean insert after consonants), and the detector matches them exactly, within one edit, by consonant skeleton for the abjads, or by sound with the same first letter and length within one. Looser sound matching was measured and dropped: 185 sentences of benign chat in those languages against 1,903 past answers collided in 1,575 pairs with the plain phonetic rule, 988 with the final rule, 229 before the rule existed. English benign pairs unchanged at 183. Three open Greek and Cyrillic attacks from round 1 promoted; katakana `ステア` (stare with the r dropped) stays open.
