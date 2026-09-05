# Adaptation write-up — pointing Handspan at MERIDIAN CORE

> Adapting to a legacy console this system had never seen took **405 lines of
> configuration** and **589 lines of core change — all of it generic, none of it
> specific to this target** — plus **$10.30** across 10 discovery runs and 7
> capabilities. Replay costs zero tokens, by construction: **0 model calls
> across 124 replays**.

Those numbers are computed, not asserted. `npx tsx scripts/adaptation-report.ts`
regenerates them from the git diff since the `pre-meridian` tag, the token usage
recorded in each discovery trace, and the result contract of every replay. The
dashboard serves the same report at `/adaptation`.

**The headline is deliberately not "zero core changes."** A core that needed no
changes is equally consistent with a core too thin to be stressed. The claim
worth defending is *N generic core edits, zero target-specific ones*, because
generic edits amortise across every app and target-specific ones never do. Every
core line is listed individually in the report so the claim can be checked
rather than accepted.

Most of that core figure arrived late and deliberately: §5 records six defects
that only surfaced once the system was measured and re-read against the brief,
and their fixes are generic to a fault — a card-number validator, a lock around
a governance counter, a timeout on a speculative match, and recording the
arguments a run was invoked with. Every one of them makes app number 2,001
cheaper too, which is the only test of "generic" that means anything.

---

## The two-page version

The brief asks for one to two pages. That is this section; everything after it
is supporting detail for a reader who wants the working, and can be skipped.

**What adapting took.** Configuration, not a rewrite: an origin and an
enumerated path list in `policy.yaml`, a risk vocabulary for this vendor's
button text, and an entry in `institutions.json`. The core changes were real but
generic — parameter references in conditions and extractions (`{{shareId}}` in a
`rowMatch`, so a checkpoint can assert the row *this caller* asked for), a
redaction hook on observation rather than at twelve call sites, a checksum gate
on card-number detection, a lock around the counter that gates approval, a
timeout on a speculative `selectOption`, and recording the arguments a run was
invoked with. Not one of them mentions MERIDIAN CORE. That is the claim I will
defend — *N generic core edits, zero target-specific ones* — because generic
edits amortise across every app onboarded and target-specific ones never do.

The one genuine coupling the adaptation exposed: the CLI imported its list of
institutions from the **fixture application's own module**, so an institution
that was not part of the mock could not be named at all. That is now a data
file, which is what makes onboarding a deployment a configuration change.

**The API contract.** A capability is a typed, versioned, reviewable artifact,
so projecting it into a function-calling tool definition is mechanical:
`GET /capabilities` returns tools an agent drops straight into its `tools`
array, scoped to the product this catalog fronts. `POST /capabilities/:id/invoke`
takes typed args and returns a four-shape discriminated union —
`success | outcome | escalated | failure` — mapped to HTTP 200 / 200 / 202 /
4xx-5xx. A business outcome returns **200 deliberately**: "no such member" is an
answer, and a caller that retries on non-2xx must not retry it forever. Secrets
and the operator identity are refused from the request body and supplied from
the server's environment, so the chatbot cannot hold a credential or ask to be a
supervisor.

**Driving the UI, and its exceptional states.** The model never sees a DOM and
the artifact never stores a selector. Elements are perceived as a screen reader
sees them — role, visible label, container, frame path — and replay resolves a
*description* with a deterministic scorer that refuses to guess when two
candidates tie. Before any capability was recorded, a recon pass provoked every
exceptional state and read its wording off the page; the first time this system
checked its detectors against remembered phrasing, **8 of 8 were dead**. All
four classes the brief names are now declared and exercised against the live
host: business outcomes (`member_not_found`, `insufficient_available_balance`,
`source_share_on_hold`), **recoverable** (the maintenance interstitial, detected
and dismissed via its `Continue` button — verified by
`scripts/verify-interstitial.ts`), hard failures (`system_error`), and
escalation (`supervisor_override_denied`).

**How the guarantees survive the new surface.** There is exactly one
`invokeCapability` path, used by the HTTP route and the chatbot alike, so the
wrapper cannot become a way around the guardrails — the brief's specific
warning. Policy classifies `Apply Hold` as irreversible and blocks it in every
mode, so discovery physically could not record that click; rather than weaken
the rule, the capability stages the request to the `CONFIRM ACCOUNT HOLD` screen
and stops, handing a supervisor a filled-in form. Authorisation is not
expressible by the model: `confirm` is removed from the schema it is given, and
the token is minted from a human's click. The lease moves
`automation → paused → operator` and `PlaywrightSurface.act()` refuses to touch
the page while a human holds it — an enforcement point, not a convention.
Regulated values are registered structurally from their *labels*, so a member's
name is scrubbed from persisted evidence even on a screen the system has never
seen before, while the caller that asked for it still gets it.

**What I left out.** A re-authentication recovery (`runSteps`) — designed and
argued in §6, not built, so a mid-flow session timeout escalates rather than
recovers. A per-step fault hook, which would close the four detectors that stay
unverified because `?inject=` can only ride a navigation. A `drift --all` fleet
sweep — the form the drift question actually takes at 300 institutions. And,
from the chatbot: memory, planning, and any ability to compose capabilities.

**What I would want a reviewer to press on.** The core figure grew late and on
purpose. Six defects only surfaced once the system was *measured* rather than
demonstrated — the audit trail was redacting its own run ids, twenty concurrent
runs recorded as one, every dropdown cost twenty seconds, a version inherited
clean-run credit it never earned, `approve` stamped the wrong version, and three
artifacts had a member's name baked into an element descriptor. Each is written
up below with the evidence. I would rather show a system that found those than
one that had never looked.

---

## Detail

## 1. What adapting actually took, and what had to change

### Where the diff went

| bucket | files | lines | what it means |
|---|---|---|---|
| config | 6 | 330 | The real per-app cost: an origin, a path list, a risk vocabulary, an institution |
| core | 7 | 292 | Should be near zero, and every line generic. This is the claim |
| surfaces | 7 | 1,742 | API, chatbot, dashboard — built once, amortised over every app |
| tooling | 4 | 272 | Recon and verification scripts, tests |
| recorded | 319 | 116,984 | Artifacts and run evidence. Output, not effort |

### The one place the core was genuinely coupled to the original target

`src/cli.ts` imported its **institution registry from `target-app/data.ts`** —
the mock application's own module, whose `TenantConfig` carries accent colours,
DOM id prefixes and the label vocabulary used to *render* the fixture. An
institution that was not part of the fixture could not be named at all.

That is the honest answer to "where was your core too coupled." It is now
`institutions.json`: four fields, no code. Onboarding an institution is an entry
in that file plus an origin in `policy.yaml`.

### Core edits, and why each is generic

| file | what changed | why it is not MERIDIAN-specific |
|---|---|---|
| `replay/evaluate.ts`, `replay/engine.ts` | `{{param}}` references in conditions and extractions | "Read the Balance of the share the *caller* named" is the ordinary case for any data grid. Without it, `rowMatch` could only hold a literal, and a grid read froze to the row it was recorded against |
| `agent/compiler.ts` | parameterise literals in extraction rules, using declared examples | The compiler already did this for step values. An input can be load-bearing without ever being typed — `shareId` names a grid row and is entered nowhere |
| `safety/redaction.ts`, `surface/web/playwright-surface.ts` | register regulated values on every observation, via an `onObserve` hook | A value whose *label* says it is regulated is regulated. The only mechanism that works for names and street addresses, which have no usable regex |
| `agent/prompt.ts`, `agent/loop.ts` | the environment header is declared per institution | It was hardcoded to "a mock app on localhost", which stopped being true the moment a hosted target arrived. Sending a model a false description of what it is operating is not acceptable |
| `config.ts` | institution registry, model client factory, bound inputs | Configuration, moved out of the fixture |

### What did *not* need changing, and is worth saying

- **The hidden per-transaction token needed no handling at all.** It is a plain
  `<input type="hidden">`; `perception.ts` drops hidden inputs before building
  the tree, so the model never sees it and the resolver cannot target it — and
  clicking the real submit button makes the browser carry it exactly as it does
  for a person. A hard problem for an HTTP-level integration; a non-problem for
  something that drives the UI the way a human does.
- **Comboboxes.** `playwright-surface.ts` already tried `selectOption({value})`
  before `{label}`, written months earlier for tenant skins. It is exactly right
  here, where the visible option label embeds a balance that changes between runs.
- **The label-derivation ladder.** Measured across 17 screens: links (84) and
  buttons (8) are 100% accessible-name; textboxes (11) and comboboxes (8) are
  **100% adjacent-table-cell**. Every data-entry field on the application, not
  one with an accessible name or a `<label for>`. Without that rung, no form
  here is addressable without a selector.

### A defect worth naming: a checkpoint that asserted *who*, not *whether*

`place_account_hold_request` was discovered while signed on as a supervisor, and
the model wrote a sign-on checkpoint asserting `"Signed on as S."`. That checks
**who** signed on rather than **that** anyone did. It is not what the step
guarantees, it is not part of the capability's contract, and it silently made
the artifact unusable by any other operator — which is precisely the path that
matters here, where a teller attempts the action and is refused.

It surfaced only when operator identity became a deployment property and the
capability was replayed as a teller: it failed at step 3 and never reached the
escalation the whole demo rests on. Corrected with `assert-checkpoint --replace`
to assert what the step actually guarantees.

The `--replace` flag exists for this distinction and only this one: a checkpoint
that is **wrong**, not one that is merely inconvenient. Weakening an assertion to
make a run pass is the thing this system is not allowed to do; ANDing a second
assertion onto a wrong one would not have helped either.

---

## 2. How capabilities are exposed as an API, and the shape of the contract

`GET /capabilities` returns function-calling tool definitions an agent can drop
straight into its `tools` array; `POST /capabilities/:id/invoke` takes typed args
and returns the same four-shape result contract the engine produces. This needed
almost no new code because **the artifact was already a contract** —
`toToolDefinition` existed before this project started.

The status mapping is the part that earns its keep:

| result shape | HTTP | why |
|---|---|---|
| `success` | 200 | outputs attached |
| `outcome` | **200** | "no such member" is an answer. A caller that retries on non-2xx must not retry it forever, and a dashboard must not count it as an error |
| `escalated` | 202 | parked on a human, not lost |
| `failure` | 4xx/5xx | split by whose fault it is |

Added for the dashboard and chatbot: `GET /capabilities/:id` (full typed
contract), `GET /runs`, `GET /runs/:id`, `GET /adaptation`.

**There is no SSE stream, deliberately.** A poll every few seconds shows a run
advancing just as well for a demo, needs no reconnection handling, and cannot
leave a socket open against a browser that navigated away. It would have been
the more impressive-looking of two things that do the same job.

---

## 3. Driving this legacy UI reliably, and classifying what it throws

Targets are `role + derived label + container`, scored by a deterministic
resolver with a minimum score and a required margin over the runner-up. **No
selectors anywhere.** Measured on the live transfer screen, the two share
pickers — the one place a tie looked plausible — score 70 against a runner-up of
30 across 19 candidates: a 40-point margin against a required 12.

Every exceptional state was **provoked and read off the page** before any
capability was recorded (`evidence/recon/SURFACE-NOTES.md`). That matters: on
this system's first outcome-verification pass against its own fixture, 8 of 8
declared detectors were dead because they were written from remembered phrasing.

| condition | HTTP | classification | why |
|---|---|---|---|
| no search match, overdraw, invalid e-mail, invalid amount, same source and destination, share on hold, rejected deposit | 200/400 | **business** | Answers the caller needs. Exit 0 |
| maintenance interstitial | 503 | **recoverable** | It renders a `Continue` button; the engine verifies the recovery made progress before letting the step retry |
| permission denied, session expired mid-flow | 403/440 | **escalate** | Both have a human remedy, and the app says so itself: *"A supervisor must sign on."* |
| application error | 500 | **hard** | The target is broken, not the automation. Its own reference code is captured |

**These detectors are verified firing, not merely declared.**
`npx tsx scripts/verify-all-outcomes.ts` replays every capability against
inputs chosen to provoke each declared outcome and reports which ones actually
matched. **24 of 33 fire against the live application, including 5/5 on funds
transfer** — see `evidence/VERIFY-OUTCOMES-meridian.txt`, which names the nine
that do not and why, per detector.

The report is *generated*, not maintained. The previous one was assembled from
several single-capability runs by hand, and went stale the moment new detectors
were declared: it described 19 detectors across 5 capabilities while the
artifacts had grown to 33 across 7. A report that disagrees with the thing it
reports on is worse than no report, because it gets read as evidence.

Probes live in `institutions.json`, not in the script: which member number does
not exist and which share is on HOLD are properties of the deployment. Hardcoding
one application's answers meant the pass could only ever verify that application.

That pass found a real defect, not just missing coverage. The host's generic
*"could not be validated"* banner matched `request_not_validated` before the
specific `invalid_initial_deposit`, and outcomes match in declaration order — so
a rejected deposit was reported as a **hard application fault** instead of a
business answer. Both are now `business`, which makes the shadowing harmless.

**Session timeout is escalate, not recoverable, and that is a cut line.** The
brief suggests recovery-by-re-authentication. `?inject=timeout` genuinely
destroys the session server-side, so recovery means re-running sign-on, and the
engine has no recovery kind that can re-run steps — `restartFromStep` is
deliberately unimplemented because restarting mid-flow can re-submit an already
committed step. A recovery that discards a half-filled form is not a recovery;
the engine already escalates on `recovery_lost_progress` for exactly that reason.
See §6.

**Review → post is a checkpoint, not two clicks.** Before the committing step
runs, the transfer asserts that the review screen restates the from-share,
to-share and amount *this invocation* was given. That needed parameter
references in conditions; without them the strongest sayable assertion was
"reached the review screen", which is not the assertion that matters.

---

## 4. How safety, evidence and escalation survive the new surface

Everything routes through **one** `invokeCapability()`. The chatbot is a driver
over the API, not a second way in — the brief's warning made structural.

Four holes the new surface exposed, all now closed:

1. **Secrets travelled in the request body.** The CLI read them from the
   environment; the HTTP surface did not — and through the bot they would have
   reached a model transcript. Now server-supplied; a caller that sends one is
   *told* it was ignored rather than having it silently dropped.
2. **The caller could choose the operator identity.** If `operatorId` comes from
   the request, a chatbot can be talked into running as `super1` and the
   teller/supervisor split becomes decorative. It is now bound to the
   deployment — which makes the escalation demo structural rather than arranged:
   this deployment *is* a teller, so a hold request can only ever escalate.
3. **The model could express an authorisation.** `confirm` was visible in the
   tool schema and it filled it in — asked to move money it produced
   `confirm: "member_funds_transfer_between_shares"` alongside the arguments.
   The server ignored it and minted the token from the human's click, so nothing
   was ever authorised by a model; but a guarantee that depends on the caller
   ignoring a field is one refactor from being lost. The field is gone.
4. **The model planned a sequence.** Three parallel calls — sign on, read one
   share, read the other — because every description begins "signs on to…".
   Sensible for an agent, wrong for a router. One call per turn, enforced.

**Redaction applies to persistence, not the return channel.** The caller asked
for the balance and gets the balance; what must never happen is that value
coming to rest in a log, a screenshot or an artifact. `scripts/audit-evidence.ts`
greps every persisted file for all five seed members' rendered values and exits
non-zero on a hit. It currently reports CLEAN across the whole tree.

That check earned its place twice more here:

- **A failing replay leaked a member's name.** On the success path the name is
  scrubbed because it is an output classified `pii` and extraction registers it;
  the failure path dumps the screen *without* extracting anything. A failure
  leaked precisely what a success protected — and failures are when a dump is
  most wanted. Fixed structurally, from an `onObserve` hook on the surface
  rather than at the twelve snapshot call sites, because the one that matters
  most is the failure path.
- **Registering off labels then over-matched.** In a header row each cell's
  derived label is the *previous* header cell, so `Status` is labelled
  `Balance`, got registered, and scrubbed the word out of every log line —
  `shareStatus` came back as `share[REDACTED]`. Column headers are page
  furniture and are now excluded.

The audit's seeds are a **regression check, not a proof**. This host is shared
and mutable — member 101555's e-mail and address changed underneath the project
while it was running — so a hardcoded list rots. The actual guarantee is the
structural one above: a value whose *label* says it is regulated is registered
for scrubbing as the screen is observed, which works on a member record the
audit has never seen. A live discovery run recorded during the final rehearsal
extracted four brand-new PII fields; all four were classified and scrubbed
without anything being added to the seed list.

One seed was deliberately removed: MERIDIAN's demo password is literally the
string `password`, and seeding it reported 41 "leaks", every one an English
sentence. A substring audit can only check a secret distinguishable from prose,
so loosening the match would be pretending to check something. That field's
guarantee comes from classification instead, which is stronger — a `secret`
input is never shown to the model, never captured, never written.

**Escalation.** `place_account_hold_request` stages a hold through to `CONFIRM
ACCOUNT HOLD` and stops. Policy classifies `Apply Hold` as irreversible and
blocks it in every mode, so discovery physically could not record that click —
correctly. Rather than weaken the rule, the capability extracts the member,
share, reason and notes so the supervisor who authorises it sees exactly what
they are approving. An automation that prepares an irreversible action and hands
it to a human is a better answer than one that pretends it may commit it. The
lease moves `automation → paused → operator`, and while a human holds it the
automation *cannot* act — `PlaywrightSurface.act()` asserts it.

---

## 5. Six defects that only appear when you measure, or re-read the brief

Everything above was verified before the system was measured. Adding two
ordinary instruments — a percentile instead of a mean, and more than one caller
at a time — and then re-reading both briefs against the code rather than against
memory of it, found six defects that every existing check had passed over. Not
one produced a wrong answer; all six were invisible by construction, which is
the point worth making about them.

### The audit trail was redacting its own correlation key

`result.json` in every run on disk reads:

```json
"runId": "replay-[REDACTED:PAN]-8e3d7a"
```

The card-number rule matches 13–19 digits. A run id carries a fourteen-digit
timestamp, so every persisted result, and nine lines of every `run.jsonl`,
scrubbed the one field that ties a result back to the run that produced it. For
a system whose central claim is auditability that is not cosmetic: the evidence
could not be correlated from its own contents.

The rule now validates what it matched, the way production DLP does — an
assigned issuer range **and** the ISO/IEC 7812 check digit. Both are needed. The
check digit alone clears nine arbitrary numbers in ten, which sounds decisive
until the tenth is a timestamp: `20260905015133`, taken from this project's own
evidence, passes Luhn cleanly. It is rejected because no card is issued in the
`2026` range.

This does not soften the file's stated "fail toward over-matching" doctrine.
Both tests are properties of the thing being detected rather than confidence
thresholds, so no real PAN stops being caught — `tests/safety.test.ts` pins ten
brands, spaced and hyphenated, before it pins a single false positive. Evidence
already on disk keeps the old redaction, correctly: evidence is immutable.

### Twenty concurrent runs recorded as one

`recordRun` increments `governance.stability.runs` — the counter that gates
approval — and it did so on the caller's own in-memory copy. Two invocations of
the same capability at once both read `runs: 12` and both wrote `13`.

Nothing had ever run two at once, which is why it survived. Nothing about the
deployment runs one at a time: the API serves concurrent requests, and the demo
script itself drives a CLI replay beside a running catalog. A unit test
(`tests/store-concurrency.test.ts`) fires twenty simultaneous records; before
the fix it counted **one**.

The counter is now re-read from disk inside a lock and incremented there, so the
file is the only source of truth for it. The lock is a lock *file* rather than
an in-process mutex, because the contending processes are genuinely separate —
`npx tsx src/cli.ts replay` and the catalog server write the same artifacts. It
is awaited rather than spun on: a synchronous spin would block the event loop,
and two runs inside one process would then deadlock, the holder never reaching
its own release.

`scripts/verify-concurrency.ts` asserts the whole path over real HTTP against
the live target — three members served simultaneously, each with its own run id
and evidence directory, each returning its own member's record, zero model
calls, and the counter advancing by exactly three.

### Every dropdown cost twenty seconds

The mean replay duration was 18s, which looked unremarkable. The p95 was 50.8s.

The tail was not variance, and not the failure runs — it was one capability,
`member_open_new_share`, at 50.5s on every successful run with under 400ms of
spread between them. A number that stable is a timeout, not work. Its step log
shows eleven steps at about a second each and two `select` steps at 20.3s.

The cause is a reasonable-looking idiom:

```ts
try {
  await el.selectOption({ value: action.value });
} catch {
  await el.selectOption({ label: action.value });
}
```

Try the value, fall back to the visible label. But Playwright auto-waits, so the
failing branch is not a fast failure — it retries for the full 20s action
timeout before throwing. The artifact records the human-visible label, so the
speculative branch failed *every time*, and every dropdown in the system paid
twenty seconds for a guess.

The fix bounds the speculative attempt at one second; the fallback keeps the
full budget, which is the branch that actually needs it. Measured against the
live target:

| capability | before | after |
|---|---|---|
| `member_open_new_share` | 50.5s | **13.1s** |
| `operator_sign_on` | 23.6s | **4.8s** |
| `member_inquiry_by_last_name` | 25.3s | **6.4s** |

The general lesson is in the constant's name. Playwright's auto-waiting is
correct for an action that must eventually succeed and exactly wrong for one
used to ask a question, so any "try this, otherwise that" against a live DOM has
to bound the speculative half itself.

### Why the ledger now reports latency per capability

A single fleet-wide percentile answers the wrong question. These flows are 5 to
14 steps long, so the spread is mostly *which capability*, not how variable any
one of them is — and whether something can be called synchronously inside a live
member conversation is decided one capability at a time.
`member_share_balance_lookup` at 6.6s belongs in a conversation;
`member_funds_transfer_between_shares` at 16.6s p95 probably wants a "let me do
that and come back to you".

It is a rolling window over recent runs rather than a lifetime figure, because
the operational question is what a call costs now. The window lags a change
until it refills, and the report says so rather than quietly printing a number
the current code would not produce.

---

### The recoverable class was analysed and never declared

§2.2 names three classes a replay must tell apart and gives "dismiss a known
interstitial" as the example of the middle one. The recon pass had already
provoked it, transcribed it verbatim, and written the conclusion down:

> **`maintenance` has a `Continue` button**, so the recoverable path is a
> `click` recovery — which the engine already verifies made progress before
> letting the step retry.

And then nothing declared it. Across all seven capabilities the classification
counts read `business 11, hard 7, escalate 7, recoverable 0` — the analysis
existed, the detector did not. A maintenance interstitial mid-flow would have
been a checkpoint failure rather than a dismissal and retry.

It is now declared on all seven, and verified against the live host rather than
asserted. `scripts/verify-outcomes.ts` could not do it: every other outcome here
is provoked by an *input*, and this one rides a navigation to a route the flow
reaches by clicking — the same limitation that leaves four detectors unverified.
So `scripts/verify-interstitial.ts` signs on for real, navigates to
`?inject=maintenance`, and checks the three things that could be wrong, through
the production code paths: the detector's text matches what the host actually
serves (503), the recovery control resolves through the real resolver (score 50,
runner-up 20), and clicking it clears the state — the progress property the
engine requires before allowing a retry.

### A member's name was baked into three artifacts, and the auditor said fine

`scripts/verify-artifact.ts` advertises "no PII value from the recording session
is baked in". It was checking three string literals — an SSN, an email and a
balance — belonging to the **fixture application**. Against MERIDIAN CORE that
check is vacuous, and it passed happily while three capabilities carried

```
"container": "Member 102777 - Johnson, Katherine"
```

as an element match signal, and quoted it again in the human-readable
description that reaches the logs. Which is how a member's name got into a
committed file, and into `/evidence` — the one thing the redaction layer exists
to prevent. It slipped through because the redactor scrubs values the run
*observed*, and this value belongs to whoever the flow was recorded against, not
to whoever it is being run for.

It is a correctness bug wearing a privacy bug's clothes. A container quoting one
member's number can never match another member's screen, so on every invocation
but the recording it is dead weight: resolution silently degrades to a lower
score instead of matching. That degradation is what surfaced it — the log line
that reports a degraded resolution prints the recorded descriptor.

Three fixes, because one would not have been enough:

- `compile()` now strips descriptors that quote an input's example value, so a
  future recording cannot bake it in. The model proposes; the compiler disposes.
- `generalise-targets` is the reviewed path for the artifacts recorded before
  that, and it went through the ordinary version-and-approval cycle.
- The artifact audit checks it **structurally** — a descriptor must not quote an
  input's example — rather than against a list of one application's data. The
  general rule needs no list, which is precisely why the old one was worthless
  on a target it had never seen.

*Residue, stated plainly:* superseded artifact versions in git still carry the
panel title. Those values are the demo host's fixture names, which the brief
states carry no real PII, and versions are immutable by design — rewriting them
would destroy the provenance chain that makes the review trail worth having. The
current version of every capability is clean, and the audit now fails loudly if
that ever stops being true.

### A new version inherited clean runs it never earned

Approval is gated on `minStableRunsBeforeApproval` clean runs. Every reviewer
edit forks a version and resets approval to draft — and left
`governance.stability` untouched, so the fork inherited the previous version's
record. A reviewer could add a step and clear a three-run gate on thirty runs of
a flow that no longer existed. A version's stability is a claim about *that*
version; editing it invalidates the claim, so `startNewVersion` now resets the
counter and the edit has to earn its own approval.

Found alongside it: `approve` called `store.load`, which deliberately prefers the
newest *approved* version — so approving stamped the version that was already
approved and reported success while the draft under review stayed a draft. Six
capabilities were "approved" that way before the output was read carefully.
Exactly the shape of the bug `loadForEdit` already exists to fix: running wants
the reviewed version, editing wants the latest, and approving is an edit.

### Four completeness gaps found by re-reading the brief against the build

Re-auditing §3.2 and §3.4 line by line, rather than from memory of what I had
built, turned up four things that were specified and not done.

**The dashboard could not open the evidence it listed.** §3.4 asks for the
evidence to be visible — steps, screenshots, DOM snapshots, timings, logs — and
the run detail showed filenames and byte counts. A reviewer could see that
`001-escalation-s12.png` existed and had no way to look at it, which is the
whole point of the tab. There is now `GET /runs/:id/evidence/:file` and an
inline viewer: screenshots render, snapshots and logs open as text.

Serving them is safe by construction rather than by intention. Screenshots are
masked in the browser before the pixels are captured and every JSON or log file
passed through the redactor on its way to disk, so there is no unredacted copy
to expose. The filename is validated against the run's own directory listing
rather than by pattern, so `..` has nothing to traverse to, and a DOM snapshot
is served as `text/plain` under a `sandbox` CSP — it is evidence to read, not a
document to execute in the dashboard's origin.

**A run did not record what it was asked to do.** §3.4 asks for each run's
inputs and outputs; the result contract carried outputs only. The evidence trail
could not answer "which member did this act on", which is the first question
anyone asks about a run that moved money. `meta.inputs` now carries the
arguments, typed by the artifact's own declaration so a member number is `pii`
because the artifact says so rather than because it looked like one — which
means an argument is scrubbed on persistence by the identical rule as an
extracted output. A `secret` never carries a value at all, not even a redacted
one: the name is recorded so a reader can see a credential was supplied, and the
value never enters the document.

The split is visible in one run: the caller gets `memberNumber: "100234"`,
because the caller supplied it; the file on disk reads `[REDACTED:SECRET]`.

**The catalog offered tools an agent could not invoke.** `GET /capabilities`
returned every artifact on disk, mixing MERIDIAN CORE's seven with the two from
the take-home fixture — a different application that happens to share the repo.
An agent reading that list could pick a tool whose tenant this deployment has
never heard of, and get an error it could not have predicted from the catalog it
was handed. The chatbot already filtered by product; the endpoint underneath it
did not, so the two disagreed about what existed. The listing is now scoped to
the product the catalog fronts, with `?product=all` for the take-home's own demo
path. Invoking by id is deliberately not filtered: the listing decides what an
agent should *discover*, not what the operator of the process may run.

**A tool description that described a different deployment.**
`place_account_hold_request` began "Signs on to Meridian Core as a supervisor
operator", with `operatorId` exampled as `super1`. Both are wrong, and wrong in
the direction that matters: `operatorId` is bound to the deployment, so a caller
cannot choose an identity, and this deployment is a teller — which is precisely
what makes the escalation structural rather than arranged. It is also the text a
routing model reads. There was a reviewed path to correct an input's wording and
none to correct the capability's own, so `revise-description` now exists and the
fix went through it: v7, provenance recorded, approval reset to draft.

Two smaller things fell out of the same pass. The catalog died on a raw
`EADDRINUSE` stack trace while the stale process kept answering — so a restart
after a code change looked like the change had not worked; it now says what is
wrong and refuses to move ports, because unlike the operator console its address
is one a caller has configured. And the README's own commands piped through
`jq`, which is not installed on the machine this will be demonstrated from.

---

## 6. What I deliberately left out, and would build next

**A re-authentication recovery kind.** The honest gap. `RecoveryAction` has no
variant that can re-run a declared prefix of a flow, so a mid-flow session
timeout escalates instead of recovering. The design is written down —
`{ do: 'runSteps', stepIds: [...] }`, with the compiler rejecting any step whose
risk is `confirmable` or `irreversible`, reusing the rule that already bans
retry on committing steps — and I would build it next. It was cut because the
three demo surfaces are must-haves and this is a refinement, and because a
recovery that silently discarded a half-filled form would be worse than the
escalation it replaced.

**HAR-based offline fixture mode.** Scoped out after thinking about it rather
than for time. `routeFromHAR` matches on method plus URL; this app POSTs to the
same URL at multiple stages of review→post, and a recorded hidden token will not
match a freshly minted one. The failure mode is not an error, it is the wrong
cached page served silently — worse than a dead network. If I build it, it gets
scoped to the read-only capabilities and documented as such.

**A per-step fault hook.** Four detectors — session timeout, server error, and
the two off-limits guards — stay unverified because provoking them needs a fault
injected at a step the flow reaches by *clicking*, and `?inject=` can only ride
a navigation. The global alternative is the shared host's System Settings screen,
which would break other candidates' demos to tick a box here. Closing this
properly means a per-step fault hook in the replay engine: a core change for the
benefit of a test, which is why it is listed here rather than built.

**A `drift --all` fleet sweep.** Drift detection and reviewed repair exist and
are proven on the fixture. What is missing is the fleet question — *the vendor
ships 4.2.2 overnight; which of your 300 institutions break?* — which is the
form the question takes at interface.ai's scale.

**Cut from the chatbot deliberately:** memory beyond a single turn, multi-step
planning, and any ability to compose capabilities. It picks one capability and
binds arguments. Anything more and it stops being a demo driver and starts being
a second product with its own safety surface.

---

## Appendix: the naming collision

The local fixture in `target-app/` is also called "Meridian Core" (v8.4). It is
a coincidence, and a reviewer could reasonably read it as fabrication. The two
are told apart by vendor and version: this target is **Cornerstone Financial
Systems' Meridian Core 4.2.1**, hosted by interface.ai; the fixture is Meridian
Core 8.4, and its artifacts are dated **2026-08-14** — twelve days before this
brief existed. Both remain in the catalog, which is why capabilities are scoped
by `surface.product`.
