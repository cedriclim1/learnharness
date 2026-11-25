# Google Antigravity CLI

Enable **Google Antigravity CLI** under Settings → Providers → External CLI.
It runs the official `agy` (or `antigravity`) binary using your existing Google
account sign-in. Your Antigravity App login is shared with the CLI on the same
machine. No Google API key or proxy server is needed.

## Start locally

```sh
npm ci
agy --version
agy models
npm run dev
```

Open http://localhost:3000, enable **Google Antigravity CLI** under Providers,
and choose an `antigravity` model for Strong, Cheap, and Vision.

When enabled, LearnHarness dynamically queries `agy models` to list the slugs
available to your account, always keeping **Antigravity · CLI default** (which
follows the CLI's configured model) alongside a curated fallback list of current
Gemini, Claude, and GPT-OSS slugs if discovery fails. Explicit model slugs fail
if your account cannot access them.

If `agy` is missing, install it using Google's
[official instructions](https://antigravity.google/docs/install/). If sign-in is
required, run `agy` interactively once. LearnHarness searches `PATH`,
`~/.local/bin`, common macOS/Linux/mise/npm/Nix directories, and the Windows
installer directories for `agy` and `antigravity`. Set `LH_AGY_BINARY` to an
absolute executable path for another installation. Use a CLI version supporting
`--settings`, `--json-schema`, and JSON input/output.

## Subscription usage

Requests use the account signed in to Antigravity. Google controls model access,
subscription quota, and rate limits. LearnHarness sets **`useG1Credits: false`
for each request**, so it does not enable spending additional AI credits after
your included quota is exhausted. It excludes Gemini API-key and ADC environment
variables from child processes (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`AGY_ADC_AUTH`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_APPLICATION_CREDENTIALS`).
Keep the CLI signed in to your personal Google account; do not configure it for
Google Cloud/enterprise billing.

Check remaining allowance with `agy -p /usage --output-format json`. Every model
operation uses quota, including research, practice, graph extraction, and
compaction. LearnHarness reports CLI pricing and effective context limits as
unknown rather than displaying a $0 estimate.

## How the integration works

The provider sends the current system prompt, available tool schemas, and full
conversation to a fresh CLI request. Antigravity returns a structured envelope
containing learner-facing text and requested harness tool calls. LearnHarness's
existing Pi agent loop executes those tools and supplies their results on the
next request. This preserves quizzes, plans, graph operations, and background
work without granting the CLI direct shell, web, file-write, or MCP execution.

Responses appear when the structured result completes; token-by-token prose
streaming is not supported in this adapter. Supplied images are written to
private temporary files (`0600` inside a `0700` directory) for the CLI to read,
and temporary request/image files are removed after completion or cancellation.
The CLI still manages its own local conversation history and logs. The app does
not modify your global Antigravity settings.

## Verification

```sh
npx tsx --test tests/antigravity.test.ts   # deterministic, no model calls
npx tsx scripts/smoke-antigravity.ts      # live tool round trip; consumes quota
npm run typecheck
npm run lint
npm run build
```
