# Handspan

**An LLM works out how to do a task inside a legacy UI that has no API. The
successful run is compiled into a typed, reviewable capability. That capability
then replays deterministically — with no model in the loop.**

Built for the interface.ai computer-use take-home. Design write-up:
**[REPORT.md](./REPORT.md)**. Evidence from real runs: **[/evidence](./evidence)**.

```
  goal ──► LLM discovery ──► capability artifact ──► deterministic replay ──► agent
           (once, Opus 5)      (typed, in git)        (thousands of times,
                                                       zero model calls)
```

---

## The one-minute version

The system is built around a single decision: **the model never sees a DOM, and
the artifact never stores a selector.**

Elements are perceived the way a screen reader perceives them — role, visible
label, container, frame path — and the model refers to them only by opaque
handles that are thrown away after each observation. Replay does not replay a
selector; it replays a *description* (`"the text box labelled Member ID in the
Member Search panel"`) and resolves it with a deterministic scoring function
that refuses to guess when two candidates tie.

That is what makes one recording work at a second institution running the same
vendor software under different branding, different labels, and different
element ids — and it is the same abstraction a desktop UI Automation adapter
would implement.

---

## Setup

Requires **Node ≥ 20**. Nothing else — the target application is included, so
there are no external services and nothing to sign up for.

```bash
npm install                 # also fetches Chromium for Playwright
cp .env.example .env        # then add your key (see below)
```

### Configuration

| Variable | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | **`discover` only** | Replay never reads it. If it did, the design would have failed. |
| `HANDSPAN_MODEL` | optional | Default `claude-opus-5`. |
| `HANDSPAN_EFFORT` | optional | Default `high`. |
| `DEMO_USERNAME` / `DEMO_PASSWORD` | the mock app | Fake, local-only. Registered with the redactor at startup so the password cannot reach a log. |

`.env` is gitignored.

### Running without live services

Everything except `discover` runs with **no API key and no network**:

```bash
npm test                              # 81 tests — resolver, policy, redaction,
                                      # schema invariants, control-transfer FSM
npx tsx tests/smoke-perception.ts     # see exactly what the model would see
npm run replay -- ...                 # deterministic replay: zero model calls
```

The two committed artifacts in [`/artifacts`](./artifacts) — both produced by
real Opus 5 runs against the live app — mean you can exercise the entire replay
path, including every error class, without spending a token.

---

## Demo path

### 0. Start the target application

A mock legacy core-banking console: iframes, table layouts, `ctl00$`-style
element ids, no test IDs, **two institutions running the same vendor product**,
and injectable runtime faults.

```bash
npm run target          # http://localhost:4300
```

Leave it running. In a second terminal:

### 1. Discovery — an LLM drives the real UI *(needs the API key)*

```bash
npm run discover -- \
  --goal "Log in as teller01, look up member 12345, and read their current savings account balance" \
  --tenant northstar
```

A browser window opens and Claude drives it. You will see each action, its risk
classification, and the resulting page. It writes:

- `artifacts/member_savings_balance_lookup.v<n>.json` — the capability, **`approval: draft`**
  (versions are immutable and additive; re-discovering writes `v<n+1>` rather
  than overwriting what a reviewer already signed off)
- `evidence/disc-<timestamp>/` — JSONL log, per-step screenshots, a11y snapshots

The repo already contains the output of two such runs — this one, and a
state-committing one (`member_open_sub_account`, step 7 below) discovered with:

```bash
npm run discover -- --tenant northstar \
  --goal "Log in as teller01, open member 12345, and open a new SAVINGS sub-account for them with an initial deposit of 100 dollars, through to the confirmation screen"
```

### 2. Inspect what it produced

```bash
npm run capabilities                          # agent-facing tool definitions
npx tsx src/cli.ts codegen -c member_savings_balance_lookup    # human-readable review document
```

### 3. Replay it — deterministically, no model

```bash
npm run replay -- -c member_savings_balance_lookup -i memberId=12345
```

Then prove it is not memorising the recording — a different member, whose
balance was never seen during discovery:

```bash
npm run replay -- -c member_savings_balance_lookup -i memberId=20881
```

### 4. Replay into the interesting failures

This is the part that matters. Each returns a **different result shape**:

```bash
# A business outcome — a valid answer, NOT an error. Exits 0.
npm run replay -- -c member_savings_balance_lookup -i memberId=99999

# A permission denial — also a business outcome, not a crash.
npm run replay -- -c member_savings_balance_lookup -i memberId=33417

# A recoverable interstitial: the engine dismisses it and carries on.
curl -X POST "http://localhost:4300/__control/fault?mode=unexpected_dialog"
npm run replay -- -c member_savings_balance_lookup -i memberId=12345

# A slow app: condition-based waiting rides it out where a fixed sleep would fail.
curl -X POST "http://localhost:4300/__control/fault?mode=slow_load"
npm run replay -- -c member_savings_balance_lookup -i memberId=12345

# A hard failure: structured, with expected vs observed and evidence pointers.
curl -X POST "http://localhost:4300/__control/fault?mode=server_error"
npm run replay -- -c member_savings_balance_lookup -i memberId=12345

curl -X POST "http://localhost:4300/__control/fault?mode=none"   # reset
```

### 5. Cross-tenant reuse — a binding, not a re-recording

Lakeshore runs the *same vendor product* as Northstar, but calls the field
"Member Number", uses different element ids, and shows a daily-notice
interstitial after login.

```bash
npx tsx src/cli.ts bind-tenant -c member_savings_balance_lookup -t lakeshore \
  --label "Member ID=Member Number" --label "Search=Find Member"

npm run replay -- -c member_savings_balance_lookup -t lakeshore -i memberId=12345
```

One artifact, two institutions, no second discovery run.

### 6. Human-in-the-loop escalation

```bash
npm run operator        # http://localhost:4400
```

Trigger an escalation by asking for something policy refuses to do unattended,
then in the console: **Take control** → drive the *same live browser window* →
**Hand control back**. The automation is blocked at the surface the whole time
the operator holds the lease, and every action the human takes is recorded.

### 7. The second capability — one that changes state

Reading a balance is the easy half. The interesting half is a flow that
*commits* something, because that is where risk classification, checkpoints and
confirmation screens have to earn their keep.

```bash
npm run replay -- -c member_open_sub_account \
  -i memberId=12345 -i accountType=Savings \
  -i nickname="Vacation Fund" -i openingDeposit=250.00
```

Twelve steps, ending on a confirmation screen, extracting the confirmation
number and the new account number. `maxRisk: confirmable` and
`requiresConfirmation: true`, so it is **blocked unattended** until a human has
approved the artifact — and the confirm step can never be auto-retried, which
the schema enforces rather than the engine remembering to.

```bash
# a member who does not exist — a business outcome on a state-committing flow,
# reached before anything is committed. Exits 0.
npm run replay -- -c member_open_sub_account \
  -i memberId=99999 -i accountType=Savings \
  -i nickname="Vacation Fund" -i openingDeposit=250.00
```

### 8. Verify the artifacts rather than trusting them

Two checks that found real defects in this repo, not decoration:

```bash
npx tsx scripts/verify-artifact.ts member_savings_balance_lookup   # 14 safety invariants
npx tsx scripts/verify-outcomes.ts member_savings_balance_lookup   # do the detectors actually fire?
npx tsx scripts/audit-evidence.ts                                  # no PII survived into /evidence
```

`verify-outcomes` replays a capability against inputs and fault modes chosen to
provoke each declared outcome, and reports which detectors *actually fire*. The
first time it ran it reported **0/8** — the model had written detector patterns
with inline `(?i)` flags, which JavaScript does not support, so every declared
outcome was silently dead. It now reports 7/7 and 6/7. The one that remains
unverified is called out as unverified rather than quietly counted.

### 9. The agent-facing surface

```bash
npm run catalog         # http://localhost:4500

curl -s localhost:4500/capabilities | jq '.tools[0]'
curl -s -X POST localhost:4500/capabilities/member_savings_balance_lookup/invoke \
  -H 'content-type: application/json' \
  -d '{"tenantId":"northstar","memberId":"12345"}' | jq
```

Or watch a caller do the whole thing — discover the catalog, build a valid call
from the published schema, and switch on the result shape:

```bash
npx tsx scripts/agent-invoke-demo.ts member_savings_balance_lookup 12345
```

`GET /capabilities` returns tool definitions an agent can drop straight into its
`tools` array. Note the status mapping: success and **business outcome both
return 200** — "no such member" is an answer, and a caller retrying on non-2xx
must not retry it forever.

---

## Commands

| Command | What it does |
|---|---|
| `npm run target` | Start the mock legacy banking app |
| `npm run discover -- --goal "..."` | LLM-driven discovery → capability artifact |
| `npm run replay -- -c <id> -i k=v` | Deterministic replay (`--repeat N` for a stability figure) |
| `npm run capabilities` | List capabilities as agent tool definitions |
| `npm run operator` | Human-in-the-loop console |
| `npm run catalog` | Agent-facing capability API |
| `npx tsx src/cli.ts bind-tenant` | Bind a capability to another institution |
| `npx tsx src/cli.ts approve` | Mark a capability approved for unattended runs |
| `npx tsx src/cli.ts codegen -c <id>` | Emit a human-readable review document |
| `npx tsx src/cli.ts declare-outcome` | Add a reviewer-authored outcome rule (recorded with `origin: reviewer`) |
| `npx tsx scripts/verify-artifact.ts <id>` | Audit an artifact: structural invariants, no baked-in credentials or PII, no id-based matching, approval traceable to a reviewer |
| `npx tsx scripts/verify-outcomes.ts <id>` | Replay each declared outcome and report which detectors actually fire |
| `npx tsx scripts/audit-evidence.ts` | Fail if any seeded PII or credential survived into `/evidence` |
| `npm test` / `npm run typecheck` | 81 tests / strict TypeScript |
| `npm run test:replay` / `npm run test:escalation` | Integration: 8 replay scenarios (0 model calls) and the full control-transfer cycle |

---

## Layout

```
src/
  types/artifact.ts       ← the capability schema + structural invariants
  types/result.ts         ← the four-shape result contract
  types/surface.ts        ← the Surface port: the seam between perceive/act and flow
  surface/web/
    perception.ts         ← page → UiNode[]; the label-derivation ladder
    resolver.ts           ← deterministic scoring; MIN_SCORE + MIN_MARGIN
    playwright-surface.ts ← driver only; no Playwright locators anywhere
  agent/                  ← discovery loop, tool surface, prompt, trace→artifact compiler
  replay/                 ← the production execution path + condition/extraction evaluation
  safety/                 ← allowlist, risk classification, redaction
  control/                ← session lease (control transfer), escalation broker
  operator/               ← human-in-the-loop console
  catalog/                ← capability store + agent-facing API
target-app/               ← the mock legacy bank: 2 tenants, injectable faults
artifacts/                ← capabilities, reviewed in git
evidence/                 ← run logs, screenshots, snapshots, results
```

## Safety posture, briefly

Every action passes the policy engine before reaching a surface — no exceptions,
in either discovery or replay. Navigation is allowlisted by origin *and* path.
Irreversible actions are **blocked unconditionally** and escalated to a human;
no token authorises one unattended. Declared secrets are registered for exact
scrubbing, so a credential cannot survive a log even when no pattern matches it,
and sensitive screen regions are masked in the browser *before* a screenshot is
captured. Limits are stated plainly in [REPORT.md §6](./REPORT.md).
