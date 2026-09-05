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

## Now pointed at MERIDIAN CORE

This repo also carries the **adaptation project**: the same core driving
`web-sample.interface-hiring.com`, a hosted credit-union servicing console it
had never seen — server-rendered table soup, a numbered menu, no test ids, a
hidden per-transaction token, review-then-post confirmations and a
supervisor-gated action.

Seven capabilities cover its whole function surface, each recorded by a real
discovery run and replaying with **zero model calls**.

- Write-up: **[ADAPTATION.md](./ADAPTATION.md)** — what it cost, what had to
  change, and what I cut.
- Live demo path: **[DEMO-SCRIPT.md](./DEMO-SCRIPT.md)**.
- What the target actually renders, measured before anything was recorded:
  **[evidence/recon/SURFACE-NOTES.md](./evidence/recon/SURFACE-NOTES.md)**.

> 405 lines of configuration, 503 lines of core change — all generic, none
> target-specific — $10.30 across ten discovery runs, and 0 model calls across
> 80 replays. `npx tsx scripts/adaptation-report.ts` recomputes it.

**Two applications are called "Meridian Core" here and it is a coincidence.**
The hosted target is Cornerstone Financial Systems' Meridian Core 4.2.1; the
fixture in `target-app/` is Meridian Core 8.4, and its artifacts are dated
2026-08-14, twelve days before the adaptation brief existed.

### Running the API, dashboard and chatbot

```bash
cp .env.example .env     # ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID,
                         # HANDSPAN_INPUT_OPERATOR_PASSWORD, HANDSPAN_INPUT_OPERATOR_ID
npx tsx src/cli.ts catalog
```

`http://localhost:4500` serves all three: the **capability catalog** as
function-calling tool definitions, a **dashboard** (catalog, run history with
per-step traces, and the adaptation ledger), and a **chatbot** that drives the
API. One process, no build step.

Credentials never travel in a request. `operatorPassword` is read from the
server's environment, and `operatorId` is bound to the deployment — so the
chatbot cannot ask to run as a supervisor, which is what makes the escalation
path real rather than arranged.

#### Invoking a capability against the live target

Everything below runs against `web-sample.interface-hiring.com`. Open
`http://localhost:4500` and use the **Chat** tab, or drive the same path over
HTTP:

```bash
# What an agent would discover: typed tool definitions, no UI knowledge needed
curl -s localhost:4500/capabilities

# Invoke one. Secrets and operatorId are refused from the body on purpose;
# the server supplies them from its own environment.
curl -s -X POST localhost:4500/capabilities/member_share_balance_lookup/invoke \
  -H 'content-type: application/json' \
  -d '{"memberNumber":"100234","shareId":"100234-S0001"}'

# The same thing through the chatbot, which picks the capability itself
curl -s -X POST localhost:4500/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What is the balance of share 100234-S0001 for member 100234?"}'

# A business outcome, NOT an error: HTTP 200, exit code 0
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST localhost:4500/capabilities/member_share_balance_lookup/invoke \
  -H 'content-type: application/json' \
  -d '{"memberNumber":"999999","shareId":"999999-S0001"}'
```

These print raw JSON. Pipe any of them through `jq` if you have it — it is not
installed by default on Windows, so nothing here depends on it.

Each response carries an `x-handspan-run-id` header. Open that run on the
**Runs** tab to see its steps, timings, the arguments it was invoked with, and
every evidence file it produced — screenshots and DOM snapshots included,
viewable in place.

A capability that commits state (a transfer, an update) will refuse an
unattended call without a confirmation token naming it. That is deliberate, and
the chatbot cannot mint one: `confirm` is not in the schema the model is given,
so the token comes from a human's click.

### Recording and replaying against the live target

```bash
# Record (needs a model). The entry path comes from institutions.json.
npx tsx src/cli.ts discover --tenant meridian-demo --headless   --goal "Sign on as the operator, open member 100234 and ..."

# Replay (never touches a model)
npx tsx src/cli.ts replay -c member_share_balance_lookup -t meridian-demo --headless   -i memberNumber=100234 -i shareId=100234-S0001

npx tsx src/cli.ts replay -c member_funds_transfer_between_shares -t meridian-demo --headless   -i memberNumber=100234 -i fromShareOption=100234-S0001-6   -i toShareOption=100234-MMKT-11 -i amount=1.00 -i memo="demo"

# The staging capability that escalates: this deployment is a teller
npx tsx src/cli.ts replay -c place_account_hold_request -t meridian-demo   -i memberNumber=100987 -i shareId=100987-S0001   -i "reasonCode=FRAUD - Suspected fraud" -i notes="pending review"

# Which of a member's shares can actually be debited right now
npx tsx scripts/open-shares.ts 100234

# Rehearse the escalation: park, hand a human the live session, hand back
npx tsx scripts/rehearse-escalation.ts

# Three members served at once, through the API (needs the catalog running)
npx tsx scripts/verify-concurrency.ts

# What the target renders, what the detectors do, and what the adaptation cost
npx tsx scripts/recon-meridian.ts
npx tsx scripts/verify-outcomes.ts member_funds_transfer_between_shares
npx tsx scripts/adaptation-report.ts
npx tsx scripts/audit-evidence.ts
```

Operator passwords are supplied through `HANDSPAN_INPUT_*` environment
variables, never on a command line where they would land in shell history.

### Onboarding another institution

```jsonc
// institutions.json
"harbor-cu": {
  "displayName": "Harbor Credit Union",
  "baseUrl": "https://harbor.example.com",
  "product": "cornerstone-meridian-core",
  "productVersion": "4.2.1",
  "environmentNote": "..."
}
```

plus its origin in `policy.yaml`. No code.

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
| `ANTHROPIC_API_KEY` | **`discover`, and `repair --assist`** | Replay never reads it. If it did, the design would have failed. |
| `HANDSPAN_INPUT_PASSWORD` | optional | Supplies a `secret`-classified input without putting it in shell history or `ps` output. Only `secret` inputs may come from the environment. |
| `HANDSPAN_MODEL` | optional | Default `claude-opus-5`. |
| `HANDSPAN_EFFORT` | optional | Default `high`. |
| `DEMO_USERNAME` / `DEMO_PASSWORD` | the mock app | Fake, local-only. Registered with the redactor at startup so the password cannot reach a log. |

`.env` is gitignored.

### Running without live services

Everything except `discover` runs with **no API key and no network**:

```bash
npm test                              # 136 tests — resolver, policy, redaction,
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
npm run discover -- --tenant northstar \
  --goal "Sign in to the servicing console (user ID: teller01, password: demo-pass-1234), look up member 12345, and read the current balance of their SAVINGS account. The member number will be different on each future invocation."
```

The goal carries the fixture credentials because the model has no other way to
get them — there is no credential store in this system by design, and a goal
that omits them produces a failed sign-in, which the model then correctly
declines to keep retrying.

A browser window opens and Claude drives it. You will see each action, its risk
classification, and the resulting page. It writes:

- `artifacts/member_savings_balance.v<n>.json` — the capability, **`approval: draft`**
  (versions are immutable and additive; re-discovering writes `v<n+1>` rather
  than overwriting what a reviewer already signed off)
- `evidence/disc-<timestamp>/` — JSONL log, per-step screenshots, a11y snapshots

The repo already contains the output of two such runs — this one, and a
state-committing one (`member_open_sub_account`, step 7 below) discovered with:

```bash
npm run discover -- --tenant northstar \
  --goal "Sign in to the servicing console (user ID: teller01, password: demo-pass-1234), look up member 12345, and open a new sub-account for them: account type Savings, nickname 'Vacation Fund', opening deposit 250.00. Continue through to the confirmation screen and read the confirmation number. The member, account type, nickname and deposit amount will all be different on each future invocation."
```

### 2. Inspect what it produced

```bash
npm run capabilities                          # agent-facing tool definitions
npx tsx src/cli.ts codegen -c member_savings_balance    # human-readable review document
```

### 3. Replay it — deterministically, no model

```bash
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345
```

Then prove it is not memorising the recording — a different member, whose
balance was never seen during discovery:

```bash
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=20881
```

### 4. Replay into the interesting failures

This is the part that matters. Each returns a **different result shape**:

```bash
# A business outcome — a valid answer, NOT an error. Exits 0.
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=99999

# A permission denial — also a business outcome, not a crash.
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=33417

# A recoverable interstitial: the engine dismisses it and carries on.
curl -X POST "http://localhost:4300/__control/fault?mode=unexpected_dialog"
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345

# A slow app: condition-based waiting rides it out where a fixed sleep would fail.
curl -X POST "http://localhost:4300/__control/fault?mode=slow_load"
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345

# A hard failure: structured, with expected vs observed and evidence pointers.
curl -X POST "http://localhost:4300/__control/fault?mode=server_error"
npm run replay -- -c member_savings_balance -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345

curl -X POST "http://localhost:4300/__control/fault?mode=none"   # reset
```

### 5. Cross-tenant reuse — a binding, not a re-recording

Lakeshore runs the *same vendor product* as Northstar, but calls the field
"Member Number", uses different element ids, and shows a daily-notice
interstitial after login.

```bash
npx tsx src/cli.ts bind-tenant -c member_savings_balance -t lakeshore \
  --label "Member ID=Member Number" --label "Search=Find Member" \
  --dismiss "Scheduled maintenance window=Acknowledge"

npm run replay -- -c member_savings_balance -t lakeshore -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345
```

One artifact, two institutions, no second discovery run. The binding carries
both halves of the per-tenant delta: what this institution *calls* things, and
what extra screens its configuration interposes.

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
  -i userId=teller01 -i password=demo-pass-1234 \
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
  -i userId=teller01 -i password=demo-pass-1234 \
  -i memberId=99999 -i accountType=Savings \
  -i nickname="Vacation Fund" -i openingDeposit=250.00
```

### 8. Drift — what happens when the vendor ships an upgrade

The brief asks (§3.7) how per-tenant and per-version drift is *detected and
managed* across hundreds of institutions on the same product. This is the
answer, and you can cause it:

```bash
# The vendor ships 8.7. Nothing is broken; the screens are just re-worded.
curl -X POST "http://localhost:4300/__control/upgrade?level=minor"

npx tsx src/cli.ts drift -c member_savings_balance \
  -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345
```

The report classifies what moved — **vocabulary** (renamed, a binding absorbs
it), **structural** (the panel moved, a human should look), **missing**,
**ambiguous**, or **checkpoint** (how the flow is *verified* changed) — and
proposes a label overlay. Nothing is changed. Exit codes are `0` stable, `10`
degraded, `1` broken, so it can gate a scheduled job.

Nothing new is instrumented to do this: replay already records which declared
signals matched, which did not, and what it matched instead. Drift analysis is
a pure function over a finished run, so it works on a `result.json` captured
weeks ago — fleet-wide analysis is a batch job over evidence, not a re-run of
every capability.

### 9. Repair — a proposal, never an edit

```bash
npx tsx src/cli.ts repair -c member_savings_balance \
  -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345
```

It writes a **new draft version** with the label overlay applied, prints the
diff, and stops. Three properties are worth pausing on:

- **`Model calls: 0`.** The analysis resolves ordinary renames deterministically.
  The `--assist` flag allows *one* bounded model call per finding the analysis
  cannot explain, and even then the model may only pick a label that was
  actually observed on screen — it cannot invent a control.
- **It may change how the flow is found, never how it is verified.** Steps,
  checkpoints, outcomes, inputs, outputs and risk policy are asserted
  byte-identical after the patch.
- **A draft never runs by accident.** An unpinned load takes the newest
  *approved* version, not the newest one.

Now make it worse — the vendor also renames the panel, which is what the
capability's checkpoint asserts:

```bash
curl -X POST "http://localhost:4300/__control/upgrade?level=major"
npx tsx src/cli.ts repair -c member_savings_balance \
  -i userId=teller01 -i password=demo-pass-1234 -i memberId=12345

curl -X POST "http://localhost:4300/__control/upgrade?level=none"   # reset
```

It refuses, and says why. The cheapest way to make a broken capability pass is
to weaken the assertion that proves it worked; a repair tool permitted to do
that is a machine for turning outages into silent data corruption.

### 10. Verify the artifacts rather than trusting them

Two checks that found real defects in this repo, not decoration:

```bash
npx tsx scripts/verify-artifact.ts member_savings_balance   # 14 safety invariants
npx tsx scripts/verify-outcomes.ts member_savings_balance   # do the detectors actually fire?
npx tsx scripts/audit-evidence.ts                                  # no PII survived into /evidence
```

`verify-outcomes` replays a capability against inputs and fault modes chosen to
provoke each declared outcome, and reports which detectors *actually fire*. The
first time it ran it reported **0/8** — the model had written detector patterns
with inline `(?i)` flags, which JavaScript does not support, so every declared
outcome was silently dead. It now reports 7/7 and 6/7. The one that remains
unverified is called out as unverified rather than quietly counted.

### 11. The agent-facing surface

```bash
npm run catalog         # http://localhost:4500

curl -s "localhost:4500/capabilities?product=all"
curl -s -X POST localhost:4500/capabilities/member_savings_balance/invoke \
  -H 'content-type: application/json' \
  -d '{"tenantId":"northstar","memberId":"12345"}'
```

Or watch a caller do the whole thing — discover the catalog, build a valid call
from the published schema, and switch on the result shape:

```bash
npx tsx scripts/agent-invoke-demo.ts member_savings_balance 12345
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
| `npx tsx src/cli.ts revise-description` | Correct a capability's description — the text a routing model reads |
| `npx tsx src/cli.ts generalise-targets -c <id>` | Strip the recording session's own data out of element descriptors |
| `npx tsx scripts/verify-interstitial.ts` | Prove the recoverable class against the live host: detect, resolve, dismiss |
| `npx tsx src/cli.ts revise-input` | Correct an input's description or example |
| `npx tsx src/cli.ts assert-checkpoint` | Add or replace a step's checkpoint |
| `npx tsx src/cli.ts reclassify-outcome` | Move an outcome between business / recoverable / hard / escalate |
| `npx tsx scripts/verify-concurrency.ts` | Serve three members at once through the API and check nothing is lost |
| `npx tsx src/cli.ts drift -c <id> [-t <tenant>]` | Replay and report how far the surface has moved from what was recorded |
| `npx tsx src/cli.ts repair -c <id> [--assist]` | Propose a reviewed patch for vocabulary drift; writes a draft, never applies it |
| `npx tsx scripts/verify-artifact.ts <id>` | Audit an artifact: structural invariants, no baked-in credentials or PII, no id-based matching, approval traceable to a reviewer |
| `npx tsx scripts/verify-outcomes.ts <id>` | Replay each declared outcome and report which detectors actually fire |
| `npx tsx scripts/audit-evidence.ts` | Fail if any seeded PII or credential survived into `/evidence` |
| `npm test` / `npm run typecheck` | 136 tests / strict TypeScript |
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
