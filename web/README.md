# Browser playground

The playground lets testers try messages against a random five-letter target. It runs
the text detector in the browser, with no OCR, transcription or model calls. Targets
come from `words.json`, not the daily NYT answer.

Run `npm run build:web` from the repository root to produce `web/dist/index.html`.
`vercel.json` contains the hosting build settings. To deploy the configured project,
run `npx vercel --prod` from the root.

`api/attempts.js` stores attempts and decode notes in Upstash Redis. Set either
`KV_REST_API_URL`/`KV_REST_API_TOKEN` or
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` in the hosting environment.
`GET /api/attempts` returns the newest 500 attempts. Useful misses can be added to
`test/attacks_open.json`, with the tester's decode note explaining the intended leak.
