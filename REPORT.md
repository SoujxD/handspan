# Handspan — Design Write-up

A computer-use system for back-office banking software: an LLM works out how to
complete a task in a UI that has no API, the successful run is compiled into a
typed capability, and that capability replays deterministically with no model in
the loop.

---

## 1. Architecture

```
                 ┌──────────────── DISCOVERY (once per flow) ────────────────┐
   goal + entry →│  agent/loop.ts ── Claude Opus 5, observe→decide→act       │
                 │        │                                                   │
                 │        ├─ every proposed action → safety/policy.ts         │
                 │        ├─ every executed action → DiscoveryTrace           │
                 │        └─ model returns a CONTRACT, not just "done"        │
                 │                          ↓                                 │
                 │              agent/compiler.ts  (trace → artifact)         │
                 └──────────────────────────┬───────────────────────────────┘
                                            ↓
                              artifacts/<id>.v<n>.json      ← reviewed in git
                                            ↓
                 ┌──────────────── REPLAY (thousands of times) ──────────────┐
   inputs      → │  replay/engine.ts ── guards → policy → resolve → act →    │
                 │                       checkpoint                          │
                 │        └─ zero model calls, asserted at the type level    │
                 └──────────────────────────┬───────────────────────────────┘
                                            ↓
                                      ReplayResult
                          success │ outcome │ escalated │ failure

                 ┌──────────── shared, surface-agnostic ────────────┐
                 │  types/surface.ts   Surface port (the seam)      │
                 │  surface/web/       perception + resolver        │
                 │  safety/            allowlist, risk, redaction   │
                 │  control/           lease, escalation            │
                 │  evidence/          JSONL + screenshots          │
                 └──────────────────────────────────────────────────┘
```

**Stack.** TypeScript/Node, Playwright, Claude Opus 5, Zod. Single process, no
queues, no database — the brief explicitly says designing abstractions that
*could* scale is valuable and prematurely building the infrastructure is not.
Artifacts are JSON files because an artifact is a *reviewable* object, and a
file in git gets diffs, blame, review, and rollback for free.

### The decision everything else follows from

**The model never sees a DOM, and the artifact never stores a selector.**

Perception normalises the live page — across all frames — into `UiNode[]`: role,
accessible name, *derived visible label*, container, frame path, ordinal. The
model refers to elements only by opaque handles (`e17`) that are reissued on
every observation and never persisted. The tool surface has no `css_selector`
parameter, so a selector cannot enter the artifact even if the model wanted one.

This is not aesthetic. Element ids in these apps are tenant-specific
(`ctl00$MainContent$txtMbr` at one institution, `MainForm$Body$txtMbr` at
another running the same vendor build). An artifact holding an id is
single-tenant by construction. An artifact holding *"the text box labelled
Member ID in the Member Search panel"* transfers, because that is the same
description a human operator would give — and because role + name + container
is exactly the triple that Windows UI Automation and macOS AX expose too.

### Three trade-offs worth defending

**A hand-written agent loop instead of the SDK tool runner.** Every proposed
action must pass through the policy engine, be recorded into a structured
trace, and — critically — have a *denial returned to the model as a normal tool
result it can reason about* rather than thrown as an error. That
intercept → classify → record → execute → observe sequence is the substance of
the system, so it lives in code that can be pointed at in review.

**A separate compiler rather than letting the model emit the artifact.** The
model proposes; `compiler.ts` disposes. Targets are re-derived with
`describeNode`, which emits only semantic signals. Checkpoints are synthesised
from observed before/after state when the model omits one. Risk is
re-classified from policy, never taken from the trace. Then `parseCapability`
enforces structural invariants. If the model produced something unsafe, the
recording fails loudly instead of writing a plausible artifact that misbehaves
three weeks later.

**Guards evaluated before every step, not only where first seen.** A session
timeout or a surprise interstitial can appear anywhere. Scoping outcome rules
`global` by default is what makes replay robust rather than positionally
lucky.

---

## 2. Artifact schema

`src/types/artifact.ts`. Zod-validated, versioned (`schemaVersion 1.0.0`),
content-hashed. Three ideas shaped it.

### (a) The artifact is a function signature, not a script

```jsonc
{
  "id": "member_savings_balance", "version": 1,
  "surface": { "product": "meridian-core", "recordedOnTenant": "northstar",
               "entryUrl": "{{baseUrl}}/login" },
  "inputs":  [{ "name": "memberId", "type": "string", "sensitivity": "internal" }],
  "outputs": [{ "name": "savingsBalance", "type": "money",
                "extraction": { "via": "fromTableCell",
                                "rowMatch": "SAVINGS", "columnLabel": "Current Balance" } }],
  "steps":   [ /* ordered, each with risk + checkpoint */ ],
  "successCheckpoint": { "kind": "textPresent", "text": "Share Accounts" },
  "outcomes": [ /* the unhappy paths, declared */ ],
  "tenants":  [ /* per-institution bindings */ ],
  "policy":   { "maxRisk": "safe", "requiresConfirmation": false },
  "governance": { "approval": "draft", "stability": { "runs": 0, "successes": 0 } },
  "provenance": { "model": "claude-opus-5", "discoveryRunId": "...", "contentHash": "..." }
}
```

An agent can read inputs/outputs/outcomes and know what it needs, what it gets
back, and what can legitimately happen — without reading a single step.
`catalog/store.ts:toToolDefinition` projects exactly that into a function-calling
tool definition, which is why the agent-facing surface needed almost no new code.

**The artifact is scoped to a vendor product, not an institution.** The recording
tenant is provenance; institutions are `tenants[]` bindings. `{{baseUrl}}`
templating keeps every URL product-generic.

### (b) `ElementDescriptor`: signals, not requirements

```jsonc
{ "description": "textbox labelled \"Member ID\" in the \"Member Search\" panel",
  "role": "textbox", "label": "Member ID", "container": "Member Search",
  "framePath": ["mainFrame"],
  "hints": { "domId": "ctl00$MainContent$txtMbr" } }   // recorded, weighted ~2
}
```

Every field is a *signal* scored at replay time, not a requirement. `hints.domId`
is deliberately near-worthless for matching — recorded so a human debugging drift
can see what changed, weighted so it can never carry a match and quietly
re-introduce tenant coupling. A test asserts a matching id cannot rescue an
otherwise-wrong candidate.

### (c) Exceptions are declared, not discovered at runtime

`outcomes[]` is a first-class field, each rule carrying a `classification`:

| class | meaning | result |
|---|---|---|
| `business` | a legitimate answer ("no such member") | `status: "outcome"`, **exit 0** |
| `recoverable` | engine can fix it and continue (dismiss an interstitial) | not terminal; recovery applied, step retried |
| `hard` | genuinely broken | `status: "failure"` |
| `escalate` | needs a person | `status: "escalated"` |

A capability that only knows the happy path is not useful in production, so the
schema makes the unhappy paths a required part of the contract rather than an
afterthought in the executor. The discovery model is asked for them explicitly
because it is the only participant that has actually read the screens.

### Invariants the schema refuses to serialise

Enforced on write **and** on load, so a hand-edited file cannot smuggle them in:

- A state-changing step with **no checkpoint** — "assume the click worked".
- **Retry on an `irreversible` or `confirmable` step** — that is how you
  double-post a transaction.
- A **literal that looks like a credential** — must be bound to a secret param.
- A **`secret` declared as an output** — returning it to a caller persists it.
- `policy.maxRisk` disagreeing with the actual steps.

### Extraction primitives

`fromLabelledCell` handles form screens (`<td>Status</td><td>ACTIVE</td>`).
`fromTableCell` handles data grids as a genuine **two-axis** lookup —
*"the Current Balance of the SAVINGS row"*. This exists because a column-header
lookup alone returns whichever row comes first, which on a member with savings
*and* checking is wrong half the time and silently so.

---

## 3. Determinism & error handling

### How replay is deterministic

Replay does not replay a selector; it replays a *description* and resolves it
with a **pure scoring function** — same snapshot plus same descriptor always
yields the same node. No model, no randomness, no wall-clock dependence.

`resolve()` scores every candidate across role / label / name / container /
framePath / ordinal and applies **two** acceptance thresholds:

- **`MIN_SCORE` (45)** — a weak best match is not a match. Better to fail with
  `target_not_found` than to click something plausible.
- **`MIN_MARGIN` (12)** — the winner must beat the runner-up. Two equally-good
  candidates means the descriptor is under-specified, and *acting on a coin flip
  inside a banking system is the worst available option*. It stops with
  `target_ambiguous` and reports what it was choosing between.

Thresholds are derived from the weight table against named cases, not picked
round — the comment in `resolver.ts` lists the five cases that pin them.

`meta.llmCalls` is asserted to be `0` before any replay result is returned, so
"no model in the decision loop" is checked rather than promised.

**Waiting is condition-based, never a fixed sleep.** `waitForCondition` polls the
same normalized snapshot the checkpoint is written against. A fixed wait is both
slower on the happy path and wrong on the slow path — the classic flaky-test
failure. The mock app's `slow_load` fault (6s) exists specifically to prove this.

### Per-step execution order

1. Snapshot.
2. **Evaluate global guards** → business / recoverable / escalate / hard.
3. **Re-derive risk from policy** and compare to the recorded risk. A mismatch
   means the policy tightened or the artifact was edited; both stop the run.
4. **Resolve** the target deterministically.
5. Act.
6. **Verify the checkpoint** — what makes "the click worked" a fact.

### The single most important detail

**When a checkpoint fails, guards are re-evaluated before declaring failure.**
The most common reason a checkpoint fails is that a *different, declared* screen
appeared. A "no such member" page failing the member-detail checkpoint is a
business outcome, not a broken capability. Without this one re-check the taxonomy
collapses back into "everything unexpected is an error", which the brief names as
the most common design mistake here.

### The failure contract

Success and business-outcome are different *shapes*, not different values of a
status string, so a caller pattern-matching on `status` cannot conflate them.
Failures carry `kind`, `atStepId`, `expected`, `observed`, `remediation`, and
evidence pointers — because "it failed" with no diff is not debuggable.

`kind ∈ target_not_found | target_ambiguous | checkpoint_failed | timeout |
recovery_exhausted | policy_denied | invalid_input | surface_error |
artifact_invalid | internal_error`

Recoverable conditions are deliberately **not** terminal states — handled inside
the engine, and promoted to `recovery_exhausted` if the budget runs out, which
keeps the taxonomy honest rather than papering over a loop.

Exit codes: success `0`, **business outcome `0`** (a scheduler retrying on
non-zero must not retry "no such member"), escalation `75` (parked, not lost),
failure `1`.

### UI drift — detection, classification, and reviewed repair

Drift shows up first as `missedSignals` on a *successful* resolution: the match
held on role + label but the container was renamed. That is logged as
`resolution_degraded`, making drift **observable before it becomes breakage**,
which is the useful moment.

`src/replay/drift.ts` turns that signal into a report. The key property is that
**nothing new is instrumented**: every resolution already records which declared
signals matched, which did not, and what it matched instead, and every
resolution *failure* already records the candidates it was choosing between with
their scores. Drift analysis is a pure function from a finished `ReplayResult`
to a report, so it runs equally well over a live check or a `result.json`
captured weeks ago — fleet-wide analysis is a batch job over evidence, not a
re-run of every capability at every institution.

It classifies, because these look identical in a log and need opposite
responses:

| kind | meaning | response |
|---|---|---|
| `vocabulary` | the institution renamed a thing | a tenant binding absorbs it; no re-recording |
| `structural` | the container was renamed or the control moved frames | the descriptor now *means* something different — a human looks |
| `missing` | nothing on screen resembles it | the flow changed; renaming fixes nothing |
| `ambiguous` | several candidates tie | the descriptor is under-specified *for this surface*; tighten, don't translate |
| `checkpoint` | the condition proving the step worked no longer matches | **verification** drift, not targeting drift |

A rename severe enough to fail resolution outright is still recoverable from
the candidate list — the control keeps its role and position and only loses the
40 points its label was carrying. `inferRename` reads it back off the
candidates under three guards: same role, shares a word with the old label, and
*exactly one* candidate survives both. That third guard is what keeps
"Member ID" → "Member Number" from becoming "Member ID" → "Last Name", which
was a live 47-vs-45 scoring tie in the real run.

**Repair is a proposal, never an edit.** `src/repair/propose.ts` writes a new
draft version with a label overlay, prints the diff, and stops. Three
constraints:

1. **The model is the fallback, not the mechanism.** Ordinary renames resolve
   deterministically at zero token cost — the captured proposal in
   [`/evidence/REPAIR-member_savings_balance.txt`](./evidence/REPAIR-member_savings_balance.txt)
   reports `Model calls: 0`. `--assist` allows *one* bounded call per finding
   the analysis cannot explain. This is the system's own thesis applied to its
   maintenance: spend the model where judgement is genuinely required, nowhere
   else.
2. **It may only choose, never invent.** An assisted proposal must name a label
   that appears verbatim among the observed candidates. A hallucinated control
   fails validation before it reaches an artifact.
3. **It may change how the flow is FOUND, never how it is VERIFIED.** Steps,
   checkpoints, outcomes, inputs, outputs, policy and surface are asserted
   byte-identical after the patch, by comparing serialised subtrees rather than
   hand-checked fields. Checkpoint drift is detected and *refused*: the cheapest
   way to make a broken capability pass is to weaken the assertion that proves
   it worked, and a repair tool permitted to do that is a machine for turning
   outages into silent data corruption.

And a draft never runs by accident: an unpinned load takes the newest
**approved** version, not the newest one, so a proposal sits until a person
approves it. Newest-wins was the original rule and it was wrong the moment
anything other than a human could write a version.

**What it found on the first run, against the unchanged application.** The
report came back `degraded`, and it was right. Two steps had recorded their
container as `"Member ID or Last Name is required."` — a validation banner that
happened to be on screen during the discovery probe, captured as if it were the
panel title. It has never broken a run, because `container` is worth 15 points
against a floor of 45, and the label and role carry the match. But it is a
descriptor that means something slightly wrong, and it would have degraded
quietly until something else moved.

That is the whole argument for the report in one example: the defect was latent
in an artifact that passes every structural invariant, replays 3/3, and has 7/7
verified detectors. And the loop closes correctly — `container` is exactly the
signal repair **refuses** to patch, so the tool that found it also declines to
fix it and hands it to a person. Left in place deliberately: fixing it by hand
would edit an artifact behind its own provenance, and the honest remedies are a
reviewer patch or a fresh recording.

---

## 4. Heterogeneity & multi-tenant

### Surface abstraction — where the seam is

`types/surface.ts` defines the entire port. Note what `UiNode` does *not*
contain: no selector, no XPath, no DOM handle, no HTML. It carries role,
accessible name, derived label, value, container, frame path — precisely the
abstraction that a screen reader consumes, and precisely what Windows UI
Automation and macOS AX expose.

Everything above the port is surface-agnostic: agent loop, compiler, resolver,
replay engine, policy, escalation, evidence. **Adding a desktop surface means
implementing `Surface`; it means changing nothing else.**

| | web today | legacy web today | desktop (design) |
|---|---|---|---|
| enumerate | DOM walk across frames | same | UIA `TreeWalker` / AX API |
| role | tag + `role` attr | same | `ControlType` → same enum |
| name | `aria-label`, content | usually **empty** | `Name` property |
| **label** | `<label for>` | **derived from table structure** | `LabeledBy` / sibling text |
| container | nearest heading-ish ancestor | same | ancestor `Pane`/`Group` name |
| act | Playwright click/type | same | `InvokePattern` / `ValuePattern` |

Playwright is used purely as a *driver* — `page.getByRole()` and friends never
appear, because a flow depending on Playwright's matching semantics is a flow
that cannot move to a desktop surface.

**The legacy-web work is already done and is the hard part.** The derivation
ladder in `perception.ts` produces a usable label for controls that have none:

1. accessible name → 2. `<label for>` → 3. **adjacent table cell** →
4. column header → 5. preceding text → 6. `<legend>`/`<caption>`

Rung 3 is what carries these apps: `<td>Member ID</td><td><input></td>` has an
empty accessible name and its only human-visible label is the cell to its left.
Rung 3 and rung 4 **swap priority inside a data grid** — in a grid the cell to
the left is a different column's *value*, not a label, and getting that backwards
makes every grid read return the wrong field. Each node records *which* rung
produced its label, so descriptor quality is auditable.

### Multi-tenant reuse

The mock app ships **two institutions running the same vendor product** with
different branding, different labels ("Member ID" vs "Member Number"), different
element id prefixes, and one behavioural difference (Lakeshore interposes a
daily-notice interstitial).

Reuse is a **binding, not a re-recording**:

```jsonc
"tenants": [{
  "tenantId": "lakeshore",
  "baseUrl": "http://localhost:4300/t/lakeshore",
  "labelOverrides": { "Member ID": "Member Number", "Search": "Find Member" },
  "additionalOutcomes": [ /* the daily notice, classified recoverable */ ],
  "overrides": {},        // per-step escape hatch — every entry is a review flag
  "verification": { "lastResult": "unverified" }
}]
```

Because targets match on role + label + container, **a label overlay is usually
the entire delta between two institutions.** `overrides` exists for when a tenant
really is different, and is intentionally awkward to use so it stays rare and
shows up in review.

**Drift detection and management.** Three mechanisms, escalating in cost:
`missedSignals` on successful resolutions is the early warning;
`governance.stability` accumulates runs/successes per capability so a degrading
binding is visible as a number; `verification.lastResult` per tenant records
whether a binding has actually been checked. Adding a binding resets
`approval` to `draft` — a new institution is a new thing to review, not an
inherited approval.

**Scale posture.** Nothing here assumes a single tenant, and nothing here builds
multi-tenant plumbing. Hundreds of institutions × ~20 apps is a *storage and
scheduling* problem for a capability registry; the design work that had to happen
now is making the artifact product-scoped and the locator strategy skin-agnostic,
because those are the choices that would be expensive to reverse later.

---

## 5. Escalation & handoff

Three things usually conflated, kept separate here.

### Detecting "stuck"

Four explicit triggers, not "something went wrong":

1. An `escalate`-classified outcome rule fires (declared in the artifact).
2. Policy blocks an **irreversible** action — the work may be valid, the
   authority is not.
3. A recoverable condition exhausts its recovery budget.
4. Discovery makes no forward progress for N consecutive steps.

The bar is *"a person could fix this and software cannot"* — escalation consumes
a human, so it is expensive and rationed.

### Routing

An `Intervention` carries what someone needs to act without reading source:
capability, goal, step id and intent, current URL, **why it stopped**, **what to
do**, plus a screenshot and the normalized snapshot the resolver was looking at.

### Transferring control — the part that is genuinely real

`control/lease.ts` is a single-holder lease with a **hard enforcement point**:

```
automation ──pause──> paused ──grant──> operator ──handBack──> paused
     ^                                                            |
     +──────────────────────── resume ────────────────────────────+
```

`PlaywrightSurface.act()` calls `lease.assertHeldBy('automation')` before it
touches the page. While an operator holds the lease the automation **cannot**
act — not by convention, but because the call throws. Read-only calls
(snapshot, screenshot) deliberately are *not* gated, because the harness must
keep observing to record what the human did.

`paused` is a distinct state on purpose: it is the moment where nobody holds the
lease. Without it, a handoff has a window in which both sides believe they are
driving.

**The session is never torn down.** The operator drives the same Chromium
window, same cookies, same frame state, same half-filled form. On resume the
engine **re-checks the step's checkpoint before re-running it** — the operator
may well have completed it, and blindly repeating a submit is exactly the bug
this whole design is trying to avoid.

Human actions are captured via an injected DOM listener producing the same
semantic vocabulary the automation uses (role / label / container), with password
fields reporting *that* they were filled and never *what*.

### What is mocked, deliberately

**The video feed only.** The console polls a screenshot at ~1 fps rather than
streaming CDP frames; the operator drives the headed browser window already open
on the machine. Making that remote is a transport swap (CDP screencast over a
WebSocket) and does not change the control model — which is the part worth
getting right. `POST /i/:id/simulate` resolves an intervention headlessly
through the identical lease transitions, which is what makes it legitimate in
evidence.

---

## 6. Safety

### Placement

The policy engine sits *below* both the agent loop and the replay engine, at the
last point before an action reaches a surface. There is no code path that acts
without a `PolicyDecision`. The model can propose anything; a hand-edited
artifact can ask for anything; neither can act.

### Allowlist

Origins **and** path patterns, both allowlists (not blocklists), with `:param`
segment matching. Segment-wise rather than regex-on-the-whole-string, so
`/member/:id` cannot match `/member/1/admin` — the mock app has a real
`/admin` route with a "Purge Member Records" button that exists purely to prove
the allowlist blocks reaching it.

### Risk model

Structural, not a selector list — a selector list is a per-tenant artifact that
would need rebuilding for every institution. Classification runs on the
**visible name of the control plus its container**, so it transfers across skins:

| class | handling |
|---|---|
| `safe` | execute |
| `sensitive` | execute; redact captured values, mask screenshot regions |
| `confirmable` | unattended only with `confirm=<capability id>`; attended freely |
| `irreversible` | **blocked always**, then escalated — no token authorises it |

The confirmation token must *name the capability*, which stops a token being
harvested from one flow and replayed against another. And there is deliberately
**no** token that authorises an irreversible action unattended: if one existed,
it would eventually be passed by default.

### Data handling

Two mechanisms, because either alone is insufficient:

- **Runtime scrubbing** — the *guarantee*. Declared `secret`/`pii` inputs are
  registered for exact-substring removal. A password cannot survive a log even
  if it matches no regex. Values shorter than 4 chars are refused, because
  registering `"a"` would scrub every `a` and destroy the evidence trail while
  appearing to work.
- **Pattern redaction** — the *heuristic*, for values nobody declared (an SSN in
  a DOM dump). Necessary, and explicitly not sufficient.

Scrub runs first (exact, certain), then patterns. The `Redactor` is a
*constructor dependency* of the evidence recorder, and no method on that class
writes unredacted bytes — so "we forgot to redact that line" is not a reachable
state. Screenshots are the exception that proves the rule: text redaction cannot
help with pixels, so sensitive regions are painted over **in the browser before
capture**, meaning an unredacted image never exists on disk.

The mock members carry SSN-shaped `412-88-7301` values specifically so this is
tested against something real rather than asserted.

### Limits, stated plainly

- **Name-based risk classification is defeated by a button labelled "OK" that
  wires a transfer.** That is why the navigation allowlist is an independent
  gate and why `irreversible` blocks rather than warns. Production wants
  per-app control catalogues and a learned classifier over observed
  consequences, not just names.
- **Prompt injection from page content is not solved.** It is *contained*: the
  allowlist bounds where an injected instruction can send the agent, and risk
  classification bounds what it can commit. A page that says "click Purge" still
  cannot get Purge clicked. That is containment, not immunity.
- **The content hash is a review signal, not security.** It detects edits since
  recording so a stale approval is visible; anyone who can edit the artifact can
  recompute the hash. Real integrity needs signing.
- Redaction patterns are heuristics and will miss novel formats. Only the
  declared-secret path is a guarantee.

---

## 7. Cuts

### What the real runs actually produced

Two capabilities, both discovered by `claude-opus-5` driving the live mock app:

| | `member_savings_balance` | `member_open_sub_account` |
|---|---|---|
| discovery run | 10 actions, 11 model calls | 20 actions, 22 model calls |
| steps recorded | 6 | 12 |
| typed inputs | 3 | 6 (incl. an `enum` and a `money`) |
| typed outputs | 5 | 5 |
| max risk | `sensitive` | **`confirmable`** |
| outcome rules | 2 discovered + 5 reviewer-added | 3 discovered + 4 reviewer-added |
| detectors verified firing | **7/7** | **6/7** |
| stability (clean runs recorded) | 3/4 | 3/5 |
| replay scenarios correct | **9/9** (incl. cross-tenant) | 7/8 |

The action counts exceed the recorded steps in both runs because the model went
and *probed* the unhappy paths — searching an id that does not exist, submitting
the form blank, trying a below-minimum deposit — and those side trips are marked
`exploratory` and excluded from the compiled flow. That is where the observed
detector wording comes from, and it is visible in the run logs.

All four safety gates were exercised against the state-committing capability
and hold independently: unattended with no token → denied; unattended with a
token *naming a different capability* → denied; correct token but still `draft`
→ denied; approved + correct token → runs. `irreversible` is refused in every
mode. Approval itself is now gated too: it needs
`minStableRunsBeforeApproval` clean runs on the record, with a `--force`
override that is written into the artifact rather than left silent — a
governance control people route around is worse than one that bends and leaves
a mark.

### The lifecycle after day one

The work that followed the submission is one theme: a capability's problems do
not start at recording time, they start three months later when the vendor
ships an upgrade. `POST /__control/upgrade?level=minor|major` makes that
happen on demand, so the response can be demonstrated rather than described:

| | `minor` (8.7) | `major` (9.0) |
|---|---|---|
| what changed | two fields re-worded | the same, plus the panel renamed |
| detection | `drift` → **broken**, classified `vocabulary` | `drift` → **broken**, classified `checkpoint` |
| repair | proposes a label overlay, **0 model calls**, writes a draft | **refuses** — verification drift is not repairable |
| after review | replays green against 8.7 | escalates to a human, as it should |

Element ids deliberately do not change in either variant, so a system that was
secretly leaning on them would sail through and prove nothing.

### Defects the build surfaced — and how

Almost all of these were silent, which is the point worth taking from this
section: the failure modes in this problem space do not announce themselves.

| Defect | How it surfaced | Why it mattered |
|---|---|---|
| `policy.yaml` used POSIX `(?i)` inline flags | a unit test | JavaScript cannot compile them — the **entire safety layer** threw on first load |
| Model emitted `(?i)` in outcome detectors | `verify-outcomes` reporting **0/8** | condition evaluation fails closed, so every declared business outcome was **silently dead** |
| Detectors written from remembered phrasing | `verify-outcomes` again | `no member found` never matches an app that says `No member record found` |
| PII leak into saved evidence | `audit-evidence` | a balance registered as `"$55,023.10"` was stored as the number `55023.1`; the redactor skipped numbers |
| SSN survived redaction | `audit-evidence` | legacy markup renders `Tax ID412-88-7301` — `\b` cannot match between `D` and `4` |
| Recovery was fire-and-hope | an integration scenario | it re-snapshotted before the frame navigated, then burned the budget on stale content |
| Guards evaluated against a half-loaded frame tree | a `recoverable` rule intermittently "unverified" | a page-level load state says nothing about a child frame — the core of a frameset app |
| Recovery progress measured by `page.url()` | same rule still unverified | in a frameset the top URL **never changes**; all navigation is in the child |
| Recoveries after a checkpoint failure unrecorded | trace showed `recoveries: 0` while logs showed recovery | that is the *common* path, so anything reading the trace concluded the rule never fired |
| A checkpoint quoting the recorded member's name | replaying a different member | a capability that only works for the member it was recorded against |
| Discovery wrote `version: 1` unconditionally | re-recording an existing capability | it **overwrote a reviewed artifact**; versions are supposed to be additive, so the store now hands out the next free number |
| Loop detection keyed on element handles | an 18-action run killed one turn before `finish` | handles are reissued every observation, so returning to the same page three times looked identical; it now compares the *semantic* description plus the URL, and spends a nudge before giving up |
| `verify-outcomes` reported 0/7 on a capability with extra parameters | reading the trace, not the summary | every probe died in pre-flight input validation, which is indistinguishable in the summary from "every detector is broken"; it now fills required inputs from the artifact's own examples and refuses to run if it still cannot |
| A goal that omits the fixture credentials | a `refusal` stop reason from the API | the model signed in wrongly, and a retried failed sign-in against a banking console is indistinguishable from credential guessing; the environment context now travels with the goal |
| Every `npm run replay` example in the README omitted the credentials | running the demo from a clean clone, as the brief asks | the code was right and the documentation contradicted the contract it enforces — anyone following the README verbatim, reviewer included, would have concluded the project was broken |
| `stability.runs` counted runs rejected at pre-flight | two mistyped commands took a healthy capability to 1/2 | a caller's typo lowered a capability's reliability score, and once approval is gated on that score, a typo can block a deployment |
| An unpinned load took the newest version, approved or not | writing the first repair draft | the moment anything other than a human can write a version, newest-wins means an unreviewed draft silently becomes what production runs |
| `escalate()` did not honour `allowEscalation` | a suite that should take 20 seconds hung for ten minutes | the check lived at each call site, so two new escalation paths forgot it; it now lives in the one function that can park a run |

Three of these were only findable by building the tool that looks for them.
`verify-outcomes` and `audit-evidence` began as evidence generators and turned
into the two most valuable pieces of the harness.

### Cut deliberately

**Real-time co-browsing.** Screenshot polling instead of CDP screencast. Cut
because the brief scopes it out and because the *control-transfer model* is the
load-bearing part — a transport swap does not change it.

**Desktop surface.** Designed to the port and documented (§4), not built. The
seam is real: the derivation-ladder work that makes legacy web tractable is the
same work a UIA adapter needs.

**Durable intervention queue.** In-memory broker with a clean interface. The
state machine and its coupling to the lease is the hard part and is real; a
database table behind `create/get/list/update` changes nothing above it.

**Assisted LLM fallback on replay failure.** Deliberately *not* built. It would
have been the flashiest stretch goal and it undermines the central claim — the
moment a model can act on the replay path, "deterministic" needs an asterisk.
The honest response to an unrecoverable state is a human, and that exists.

**`restartFromStep` recovery.** Rejected rather than stubbed: restarting mid-flow
can re-submit an already-committed step. It escalates instead.

### What I would build next, in order

1. **Verification runs as a first-class command.** Replay a capability against a
   tenant on a schedule with synthetic inputs, write `verification.lastResult`,
   and alert on `missedSignals` appearing. Drift detection is designed and
   observable but not yet automated — this is the highest-value next increment.
2. **Promote human demonstrations into capabilities.** Operator actions are
   already captured in the artifact's own semantic vocabulary. Turning a
   recorded intervention into proposed steps closes the loop: every escalation
   makes the capability better instead of merely unblocking one run.
3. **Canonicalisation for cross-tenant fan-out.** Cluster capabilities by
   `product` + `productVersion`, diff descriptors across bindings, and propose
   label overlays automatically rather than by hand.
4. **A stronger risk model** — per-app control catalogues, and consequence-based
   classification rather than name-based.
5. **Artifact signing**, replacing the review-signal hash with real integrity.

### Known rough edges

- **A recoverable condition that destroys work in progress is not recoverable.**
  This was previously written up here as a recovery-budget problem. Reading the
  run properly showed it was not: dismissing the advisory that interrupts a
  half-filled sub-account form navigates away and *discards the form*, so the
  step resumes on a screen where its target legitimately does not exist. The
  engine reported `target_not_found` at step 11 and pointed whoever was on call
  at a button that was never the problem.

  It now detects that a recovery is the suspect — a resolution failure on a step
  that has already recovered — and escalates with the guard named, because a
  person can re-enter the form and the engine cannot. Two supporting limits went
  in alongside it: a per-run cap on how often one recoverable rule may fire
  before it stops being an anomaly (`maxGuardFiringsPerRun`), and honouring
  "escalation disabled" inside `escalate()` itself rather than at each call
  site, since two new paths promptly forgot to check it and turned a
  twenty-second test into a ten-minute wait for an operator who was never
  coming. The remaining honest limit: the flow still cannot *complete* under
  that fault unattended, and should not — re-entering discarded input is a
  human's job.
- **One detector on the sub-account capability is unverified.** Provoking
  `required_field_missing` needs a blank required field, which the typed input
  contract rejects before the browser is touched. Verifying it needs a probe
  mode that bypasses input validation — worth adding, not yet added.
- **The discovery model under-declares outcomes.** Both runs needed a reviewer
  to add four rules each. That is the designed workflow and the provenance is
  recorded (`origin: reviewer`), but the honest reading is that discovery gets
  you most of a contract, not all of it.
- **Evidence a cleanup step can delete is evidence you do not have.** An
  earlier pass of this work lost both discovery run directories to a careless
  `rm -rf evidence/*` and had to pay for the runs again. Both are now present
  and referenced by `provenance.discoveryRunId`, but the design lesson stands:
  a run directory should be append-only to everything except an explicit
  retention policy, and nothing in this repo enforces that yet.

- `container` derivation is heuristic (nearest heading-ish preceding sibling).
  It handles the panel patterns enterprise apps reinvent, and it will mislabel
  unusual layouts. `missedSignals` makes that visible rather than silent.
- The discovery model can under-declare business outcomes. The compiler
  backfills inferred *parameters* but cannot invent outcomes it was never told
  about; a checkpoint failure on an undeclared screen is the designed backstop.
- Replay opens a fresh browser per run. Fine at this scale, wrong at production
  volume — session pooling is a real cost item and is not addressed.
