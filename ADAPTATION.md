# Adaptation write-up — pointing Handspan at MERIDIAN CORE

> Adapting to a legacy console this system had never seen took **330 lines of
> configuration** and **292 lines of core change — all of it generic, none of it
> specific to this target** — plus **$10.30** across 9 discovery runs and 7
> capabilities. Replay costs zero tokens, by construction: **0 model calls
> across 53 replays**.

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

---

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
`npx tsx scripts/verify-outcomes.ts <capability>` replays each capability
against inputs chosen to provoke each declared outcome and reports which ones
actually matched. **13 of 19 fire against the live application, including 5/5 on
funds transfer** — see `evidence/VERIFY-OUTCOMES-meridian.txt`, which also
explains, per detector, why the other six could not be reached.

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
See §5.

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

## 5. What I deliberately left out, and would build next

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
