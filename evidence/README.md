# Evidence

Two capabilities, both discovered by a real LLM run against the live mock
application, then replayed across every result class the contract can produce.

| Capability | Index | Discovery run id |
|---|---|---|
| `member_savings_balance_lookup` — read a member's SAVINGS balance (read-only) | [INDEX](./INDEX-member_savings_balance_lookup.md) | `disc-20260814-064328-08afad` |
| `member_open_sub_account` — open a sub-account through to confirmation (**state-committing**) | [INDEX](./INDEX-member_open_sub_account.md) | `disc-20260814-073435-418498` |

> **Missing: the discovery run directories.** Both capabilities came out of real
> `claude-opus-5` runs against the live application — the run ids above are
> recorded in each artifact's `provenance`, along with the model, effort setting
> and timestamp — but the `disc-*` directories themselves were destroyed by a
> careless `rm -rf evidence/*` while regenerating the replay set, and restoring
> them means paying for another discovery run. They are noted here rather than
> quietly omitted. Everything below describes evidence that is present.

## What is in each directory

| Directory | Contents |
|---|---|
| `disc-*` | A **discovery run**: `run.jsonl` (every model decision, action, policy verdict), `discovery-trace.json`, per-step screenshots, and the normalized accessibility snapshot the model reasoned about. |
| `replay-*` | A **replay run**: `run.jsonl`, `result.json` (the full result contract), `scenario.json` (what was being demonstrated and why), and — on failure — a screenshot, DOM dump, and the a11y snapshot the resolver was looking at when it gave up. |

## The two claims this evidence is meant to settle

**1. Discovery was real.** `disc-*/run.jsonl` records each model call, the tool
it chose, the intent it gave, the policy decision, and the resulting screen —
see the note above on why those directories are absent from this snapshot.
What remains in evidence: each artifact's `provenance` block (model, effort,
run id, timestamp, content hash), and the fact that the artifacts contain
observed page text nobody wrote by hand.

**2. Replay uses no model.** Every `result.json` carries `meta.llmCalls`, and
it is `0` in all of them — asserted in code before any result is returned, not
just reported.

## Reading a failure

Failures are the interesting ones. `result.json` → `failure` gives
`kind`, `atStepId`, `expected`, `observed`, and `remediation`. For a resolution
failure it also lists the candidates it was choosing between with their scores,
which is usually enough to see the problem without opening the browser.

## Redaction

Regulated values are returned to the caller and scrubbed from everything
persisted here. `npx tsx scripts/audit-evidence.ts` greps every file in this
directory for the seeded SSNs, emails, and credentials and exits non-zero if any
survive. It currently reports clean.

That check earned its place: it caught a real leak. An extracted balance was
registered for scrubbing as the string it was scraped from (`"$55,023.10"`) but
stored as the coerced number `55023.1`, and the redactor passed numbers through
untouched.

## Outcome verification

`npx tsx scripts/verify-outcomes.ts <capabilityId>` replays each capability
against inputs and fault modes chosen to provoke its declared outcomes, and
reports which detectors actually fire:

- `member_savings_balance_lookup` — **7/7 verified**
- `member_open_sub_account` — **6/7 verified**; `required_field_missing` is
  honestly unverified, because provoking it needs a blank required field and
  the typed input contract rejects that before the browser is touched.

This pass exists because a detector written from remembered phrasing rather
than observed text never matches, and fails silently. On its first run it
reported **0/8** — every declared detector was dead.

## The agent-facing path

Not captured as a file here, deliberately: the transcript of a caller invoking
a capability contains the member's name, which is exactly the class of value
this system keeps out of persistent storage. Writing it into `/evidence` to
prove a point would contradict the point. It is one command to reproduce:

```bash
npm run target & npm run catalog &
npx tsx scripts/agent-invoke-demo.ts member_savings_balance_lookup 12345
```

It prints the published tool definitions, then two invocations — one returning
`success` with typed outputs, one returning the `member_not_found` **business
outcome at HTTP 200** — both with `meta.llmCalls: 0`.
