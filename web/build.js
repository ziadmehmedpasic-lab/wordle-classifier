// bundles web/app.js (which pulls in detector.js and its dictionaries) into one iife and
// splices it into template.html. output is a single self-contained page for the artifact.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const out = path.join(dir, "dist");
fs.mkdirSync(out, { recursive: true });

const result = esbuild.buildSync({
  entryPoints: [path.join(dir, "app.js")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  inject: [path.join(dir, "shim.js")],
  write: false,
  logLevel: "warning",
});
const js = result.outputFiles[0].text;
const template = fs.readFileSync(path.join(dir, "template.html"), "utf8");
if (!template.includes("<!--BUNDLE-->")) throw new Error("template.html has no <!--BUNDLE--> placeholder");
const html = template.replace("<!--BUNDLE-->", () => `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`);
const file = path.join(out, "playground.html");
fs.writeFileSync(file, html);
console.log(`${file} ${(html.length / 1e6).toFixed(2)} MB`);
