![License](https://img.shields.io/github/license/TeamControlium/utils)
<p align="center">
  <img src="https://github.com/TeamControlium/.github/raw/main/branding/teamcontrolium-banner.svg" width="100%" alt="TeamControlium — test automation frameworks & tooling">
</p>

# @controlium/utils

**Status: work in progress.** Layer 1 of [Controlium](https://github.com/TeamControlium)
ecosystem — foundational, tool-agnostic utilities that `@controlium/framework` and
`@controlium/cucumber` build on. Some modules (`Mock`, `XmlUtils`, `YamlUtils`) newer and
less exercised in real test suites than others (`Utils`, `StringUtils`, `JsonUtils`,
`Logger`); API shape across whole package still be expected to move.

Controlium is *ground-up* rewrite of test frameworks delivered for recent clients — themselves
derived from TeamControlium .NET/Java frameworks and delivering high-test-count reliable/robust
API-Based and Browser-based AUT Test Suites.

## Requirements

- Node.js >= 22 (enforced at import time)
- ESM only. `package.json` has `"type": "module"`; `exports` declares `"import"` only, no
  `"require"`. No CommonJS build.

## Install

```sh
npm install @controlium/utils
```

## What's in it

Every export below is static-only (no instantiation) and comes from `@controlium/utils`:

```ts
import { Logger, LogLevels, Detokeniser, ValueExpression, Validate, Utils } from '@controlium/utils';
```

| Export | What it does |
|---|---|
| `Logger` (alias `Log`), `LogLevels` | Logging backbone everything in ``Utils`` package — and every layer above it — reports through. Isolated: imports nothing under `src/`, only Node built-ins and external packages to prevent logging loops. |
| `Detokeniser` | Resolves `<%verb\|arg\|arg%>`-style tokens embedded in strings (`random`, `date`, `timezone`, `diff`, `setting`, `base64`, `jwt`, `mockintercepts` built in; allows custom verbs via `addCallback`). Token boundary, delimiter, escape character, and max nesting depth are configurable. |
| `ValueExpression` | Parses a single `source,cast:value` expression — convention used anywhere plain string, file's contents, or cast to `number`/`boolean`/`json` might be valid for same slot (header value, DataTable cell, etc.). |
| `Validate` | Centralised comparison engine (`equals`/`contains`/`startswith`/`regexp`/etc., combinable as `CompareTypes` set) used by every assertion-shaped validation across framework, so comparison semantics grouped. |
| `Utils` | General test-oriented grab-bag of generic helpers; settings resolution (`getSetting` — env var → npm config → context parameter → default, every source logged), file I/O, random values, type/shape assertions, environment variable snapshot/restore. etc |
| `StringUtils` | Safe string manipulation utilities — trimming, splitting (plain and quote-aware), line-ending escapes, control-character cleanup. |
| `JsonUtils` | Safe JSON querying (JSONPath-based), mutation, sentinel-based key deletion (`_undefined`/`_null`), and JSON/JSON5 parsing/validation. |
| `XmlUtils` | XML parsing (to a `slimdom` `Document`), XPath querying, and formatting. |
| `YamlUtils` | YAML parse/stringify — currently minimal (`JSON.parse`/`JSON.stringify` equivalent pair only, no comment-preserving `Document` mutation currently). |
| `APIUtils` | HTTP-level primitives: server-listening checks, and raw HTTP operation path to facilitate malformed/non-compliant requests as may be required by test-automation infrastructure. |
| `Mock` | Static HTTP interception/mocking. Takes plain, tool-agnostic `{ url, method, headers, body }` object another mechanism already captured (Playwright's `page.route()`, MSW, …) and returns decision (default deny), every transaction recorded regardless of outcome. |
| `Settings` | Thin, test-runner-agnostic wrapper remembering "current" context (e.g. Cucumber World) so `profileParameterName`-sourced setting can resolve without being threaded through explicitly. Caches context, never resolved value. |

## Design principles

Package (as per all TeamControlium repos) follows specific, non-default set of
conventions — defensive coding as baseline to ensure safety and handling of poorly
behaved AUTs

## Development

- `npm run build` — clean + compile to `dist/esm`, with `.d.ts` output
- `npm run typecheck` — `tsc --noEmit`, no build output
- `npm test` — unit tests (Vitest)
- `npm run test:coverage` — unit tests with coverage (thresholds enforced: 90% statements/lines,
  88% branches, 90% functions, in `vitest.config.ts`)
- `npm run lint` / `npm run lint:check` — ESLint, with/without autofix

## License

Apache-2.0.
