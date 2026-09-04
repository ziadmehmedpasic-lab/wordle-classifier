// builds gif, mp4 and png fixtures with ffmpeg for the frame tests. text frames need a font on the machine.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("ffmpeg-static");

const FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];
const font = FONTS.find((f) => fs.existsSync(f)) || null;

// one input per frame, concatenated. frames are ["text", ...] with a font, or ["red", "blue", ...] colours without one
function clip(file, frames, { secondsEach = 1, text = false } = {}) {
  if (text && !font) throw new Error("no font found for drawtext fixtures");
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of frames) args.push("-f", "lavfi", "-i", `color=${text ? "white" : f}:s=320x120:d=${secondsEach}:r=5`);
  const chains = frames.map((f, i) => text
    ? `[${i}:v]drawtext=fontfile=${font}:text='${f}':fontsize=64:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2[v${i}]`
    : `[${i}:v]null[v${i}]`);
  const concat = frames.map((_, i) => `[v${i}]`).join("") + `concat=n=${frames.length}:v=1:a=0[out]`;
  args.push("-filter_complex", chains.join(";") + ";" + concat, "-map", "[out]");
  if (file.endsWith(".png")) args.push("-frames:v", "1");
  args.push(file);
  execFileSync(ffmpeg, args);
  return file;
}

module.exports = { clip, font, ffmpeg };
