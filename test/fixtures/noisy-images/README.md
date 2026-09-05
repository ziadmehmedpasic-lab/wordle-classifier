# Noisy image examples

These four PNGs were supplied as spoiler-filter test cases. `static.png`, `dots.png`
and `handwriting.png` contain WAGER; `flat-gray.png` contains SOUPY. These are fixed
test answers, not a statement about today's puzzle.

Keep the original bytes. The OCR tests and evaluation runner also make JPEG copies
at quality 85. Text-free top/bottom strips from the static/dot examples provide noise
controls. Other cases protect a different word to check for false positives.

The crossed-line handwriting is a known OCR miss. Haiku 4.5 also missed the original
in the initial vision evaluation. Keep it in the attack manifest even if it remains
undetected; a passing OCR test suite does not imply coverage of this image.
