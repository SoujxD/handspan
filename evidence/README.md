# Evidence

Two capabilities, both discovered by a real LLM run against the live mock
application, then replayed across every result class the contract can produce.

| Capability | Index | Discovery run |
|---|---|---|
| `member_savings_balance` — read a member's SAVINGS balance (read-only) | [INDEX](./INDEX-member_savings_balance.md) | [disc-20260814-203551-eb30cf](./disc-20260814-203551-eb30cf) — 10 actions, 11 model calls |
| `member_open_sub_account` — open a sub-account through to confirmation (**state-committing**) | [INDEX](./INDEX-member_open_sub_account.md) | [disc-20260814-213001-926de7](./disc-20260814-213001-926de7) — 20 actions, 22 model calls |

Each artifact's `provenance.discoveryRunId` names the directory it came out of,
so any claim in the artifact can be traced back to the turn that produced it.

## What is in each directory

| Directory | Contents |
|---|---|
| `disc-*` | A **discovery run**: `run.jsonl` (every model decision, action, policy verdict), `discovery-trace.json`, per-step screenshots, and the normalized accessibility snapshot the model reasoned about. |
| `replay-*` | A **replay run**: `run.jsonl`, `result.json` (the full result contract), `scenario.json` (what was being demonstrated and why), and — on failure — a screenshot, DOM dump, and the a11y snapshot the resolver was looking at when it gave up. |

## The two claims this evidence is meant to settle

**1. Discovery was real.** `disc-*/run.jsonl` records each model call, the tool
it chose, the intent it gave, the policy decision, and the resulting screen.
Model id, effort, token counts and stop reason are in `discovery_complete`, and
the per-step screenshots show the application actually moving. Both runs also
contain probes the model chose to take — searching an id that does not exist,
submitting the form blank — which is where the observed detector wording in the
artifacts comes from.

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

- `member_savings_balance` — **7/7 verified**
- `member_open_sub_account` — **6/7 verified**; `required_field_missing` is
  honestly unverified, because provoking it needs a blank required field and
  the typed input contract rejects that before the browser is touched.

This pass exists because a detector written from remembered phrasing rather
than observed text never matches, and fails silently. On its first run it
reported **0/8** — every declared detector was dead.

## Drift and repair

Two transcripts, captured against the mock app pretending to be a newer vendor
release (`POST /__control/upgrade?level=minor`):

| File | What it shows |
|---|---|
| [`DRIFT-member_savings_balance.txt`](./DRIFT-member_savings_balance.txt) | The drift report: the run broke, the cause is classified as **vocabulary** drift, and the rename is read back off the candidates the resolver rejected. |
| [`REPAIR-member_savings_balance.txt`](./REPAIR-member_savings_balance.txt) | The repair proposal: two renames, `Model calls: 0`, written as a **draft** version, with two structural findings refused. |

The line worth reading twice in the repair transcript is `Model calls: 0`.
Ordinary renames are resolved deterministically; the model is a fallback for
findings the analysis cannot explain, not the mechanism. And under the `major`
variant — which also renames the panel the capability's checkpoint asserts —
repair refuses outright, because the only way to make that pass is to weaken
the assertion that proves the step worked.

## The agent-facing path

Not captured as a file here, deliberately: the transcript of a caller invoking
a capability contains the member's name, which is exactly the class of value
this system keeps out of persistent storage. Writing it into `/evidence` to
prove a point would contradict the point. It is one command to reproduce:

```bash
npm run target & npm run catalog &
npx tsx scripts/agent-invoke-demo.ts member_savings_balance 12345
```

It prints the published tool definitions, then two invocations — one returning
`success` with typed outputs, one returning the `member_not_found` **business
outcome at HTTP 200** — both with `meta.llmCalls: 0`.
