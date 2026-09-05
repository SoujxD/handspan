# Demo script — Handspan against MERIDIAN CORE

Ordered so the strongest beats land early enough to survive an overrun. Every
command below has been run against the live target exactly as written.

**Before you start**

```bash
npm install                       # postinstall fetches Chromium
cp .env.example .env              # then fill ANTHROPIC_API_KEY and ANTHROPIC_WORKSPACE_ID
npx tsx src/cli.ts catalog        # http://localhost:4500  — API + dashboard + chatbot
```

Open `http://localhost:4500`. Three tabs: **Catalog**, **Runs**, **Chat**, plus
the **Adaptation ledger**. Leave Runs open on a second screen if you have one —
every beat below appears there as it happens.

> Windows note: none of the commands below pass a leading-slash argument, so
> Git Bash has nothing to rewrite. Each institution declares its own entry path
> in `institutions.json`. If you do hand-type one (`--entry /signon`), prefix
> the command with `MSYS_NO_PATHCONV=1` or Git Bash turns it into a filesystem
> path — the allowlist catches that, which is reassuring in a test and a stumble
> on stage.

---

## 1 · The whole loop, in thirty seconds  *(Chat tab)*

> **What is the balance of share 100234-S0001 for member 100234?**

One model call picks a capability and binds arguments. The run itself makes
**zero**. Switch to Runs and it is there: 7 steps, ~6s, `llmCalls 0`.

Open the run. It shows the arguments it was invoked with — and the password
recorded as *supplied by the server, never recorded* — its per-step timings,
and every evidence file, openable in place. Click a `.png` and you are looking
at the masked screenshot; click the `.a11y.json` and you are looking at exactly
what the resolver saw.

*Say:* "The model chose which capability to call. It did not decide a single
click — those were recorded once and reviewed."

---

## 2 · An answer, not a crash  *(Chat tab)*

> **What is the balance of share 999999-S0001 for member 999999?**

Comes back as a **business outcome**, HTTP **200**, exit code 0:

> *"No member matched the member number. That is an answer, not an error: the
> application reported it and the run completed cleanly (member_not_found)."*

*Say:* "'No such member' is an answer. A caller that retries on non-2xx must not
retry it forever, and a dashboard must not count it as an error. That is why the
result contract has four shapes rather than success-or-error."

**Optional half-beat, and a good one.** Ask it without the share id —

> **What is the balance for member 999999?**

— and it does *not* run anything. It asks which share, because `shareId` is a
required input and it is not allowed to invent one. Worth ten seconds: "the
model binds arguments, it does not make them up."

*(Equivalent if you prefer a name: **"look up the member with last name
Nonexistent"** returns the `no_member_match` outcome the same way.)*

---

## 3 · Moving money, and who is allowed to authorise it  *(Chat tab)*

**Before this beat, check which shares are actually spendable.** The host is
shared and its state moves under you:

```bash
npx tsx scripts/open-shares.ts 100234
```

It prints the member's OPEN shares, most funded first, and a ready-to-paste
`-i fromShareOption=… -i toShareOption=…` pair. Run it once just before you
start and use whatever it gives you.

**If a share does get held mid-demo anyway**, you get the `source_share_on_hold`
business outcome instead of a confirmation number — which is a *better* beat, so
take it: "the application changed underneath us between one run and the next,
and the capability reported it as an answer rather than falling over."

> **Transfer 1 dollar from share 100234-S0001-6 to share 100234-MMKT-11 for member 100234, memo demo**

The bot **stops** and restates the transaction. Nothing has happened yet. Click
**Authorise**.

*Say three things:*
- The model cannot authorise this. The `confirm` field is not in the schema it
  is given — authorisation is not expressible. The token is minted from your
  click, in code.
- Before the committing step ran, a checkpoint asserted the review screen was
  restating *these* accounts and *this* amount. That is the difference between
  verifying a transaction and clicking two buttons.
- It never saw a credential either. Secret inputs are stripped from the schema;
  the server supplies them from its own environment.

Returns a real confirmation number, e.g. `CN480223`.

---

## 4 · An injected fault, classified  *(terminal)*

```bash
MSYS_NO_PATHCONV=1 npx tsx src/cli.ts replay \
  -c member_share_balance_lookup -t meridian-demo --headless \
  -i memberNumber=100234 -i shareId=100234-S0001
```

Then show the taxonomy is grounded rather than guessed:

```bash
sed -n '/Exceptional states/,/^## /p' evidence/recon/SURFACE-NOTES.md
```

*Say:* "Every one of those strings was provoked and read off the page before a
single capability was recorded. The first time this system verified detectors
against its own fixture, 8 of 8 were dead — written from remembered phrasing.
That is why recon happens before discovery."

---

## 5 · The escalation  *(terminal — the ninety seconds that matter)*

```bash
MSYS_NO_PATHCONV=1 npx tsx src/cli.ts replay \
  -c place_account_hold_request -t meridian-demo \
  -i memberNumber=100987 -i shareId=100987-S0001 \
  -i "reasonCode=FRAUD - Suspected fraud" -i notes="suspected fraud - pending review"
```

*Say, in this order:*
- This deployment **is** a teller. `operatorId` is bound to the deployment, not
  the request — so the bot cannot ask to be a supervisor. The escalation is
  structural, not arranged.
- Policy classifies `Apply Hold` as irreversible and blocks it in **every** mode,
  so discovery physically could not record that click. Rather than weaken the
  rule, the capability stages the request through to `CONFIRM ACCOUNT HOLD` and
  stops, extracting member, share, reason and notes — so the supervisor sees
  exactly what they are approving.
- The lease moves `automation → paused → operator`. While a human holds it the
  automation *cannot* act: `PlaywrightSurface.act()` asserts it before touching
  the page. It is an enforcement point, not a convention.

**Open the console URL the command prints, not `:4400` from memory.** Each
process serves its own interventions, so when the catalog already holds 4400
this run binds a fresh port and prints it — e.g. `http://localhost:54473`. Open
the intervention there, **Take control**, sign on as `super1` in that same
browser, apply the hold, then **Hand back**.

**Rehearse this one before you travel** — it is the beat with a live browser, a
second identity and a lease transfer in it:

```bash
npx tsx scripts/rehearse-escalation.ts
```

It drives the whole cycle through the console's own HTTP endpoints and asserts
the load-bearing part: that while a human holds the session, the automation
*cannot* act. Nine checks, all against the live target.

Ask it through the **chatbot** too — it is refused before anything starts,
because an unattended invocation of a `draft` capability is not permitted. Two
independent gates, one demo.

---

## 5½ · Three members at once  *(terminal — 30 seconds, and worth it)*

Leave the catalog running and, in a second terminal:

```bash
npx tsx scripts/verify-concurrency.ts
```

Three members served simultaneously through the HTTP API. Five assertions: own
run id and evidence directory each, no crossed sessions, zero model calls, and
the stability counter advancing by exactly three.

*Say:* "This is the first thing a platform team asks and the last thing a demo
usually shows. It was also broken — `recordRun` did a read-modify-write on the
counter that gates approval, so twenty simultaneous runs recorded as one. It
survived because nothing had ever run two at once. The unit test fires twenty
and the counter now reads twenty."

---

## 6 · The closing argument  *(Adaptation ledger tab)*

```bash
npx tsx scripts/adaptation-report.ts
```

It prints the current figures — do not read them off this page, they move every
time you run anything. At the time of writing: **405 lines of configuration, 452
lines of core** (every line listed so you can check each is generic), **$10.30**
across ten discovery runs for seven capabilities, and **zero model calls across
68 replays**.

*Say:* "The headline is deliberately not 'zero core changes'. A core that needed
no changes is equally consistent with a core too thin to be stressed. The claim
I will defend is *N generic core edits, zero target-specific ones* — because
generic edits amortise across every app you onboard, and target-specific ones
never do. The one genuine coupling I found is in there too: the CLI used to
import its institution list from the mock application's own module."

**If someone notices the core number grew**, that is the right thing to notice
and the answer is a good one. It went from 292 to 452 in the last three commits,
and all of it is the three defects in ADAPTATION.md §5: a card-number validator,
a lock around a governance counter, and a one-line timeout on a speculative
`selectOption`. None is about MERIDIAN CORE. Every one of them makes app number
2,001 cheaper too, which is the whole test of whether a core edit was generic.

---

## Backup, if the network misbehaves

Everything above already happened and is on disk:

```bash
npx tsx scripts/audit-evidence.ts     # PII audit across all persisted evidence
npx vitest run                        # 128 tests
ls evidence/                          # every discovery and replay run
```

`evidence/recon/SURFACE-NOTES.md` carries the measured label-ladder table, the
resolver margins, and the verbatim wording of every exceptional state.

---

## Questions worth pre-loading

**"Why is replay deterministic — couldn't the model just drive it live?"**
It could, and it would cost tokens per invocation, vary run to run, and be
unauditable. Discovery is where judgement belongs; replay is where repeatability
does. `meta.llmCalls` is asserted in code before any result is returned, not
merely reported.

**"What happens when the vendor changes the UI?"**
Drift detection and reviewed repair exist and are proven on the fixture app:
renames are resolved deterministically (`Model calls: 0`), and repair *refuses*
when the only way to make a run pass is to weaken the assertion that proves the
step worked. The fleet sweep — which of 300 institutions break — is on the
next-steps list, honestly.

**"How long would a second app take?"**
The ledger is the answer, with the rework left in: several of those runs
re-recorded one capability while I was fixing compiler and redaction bugs, and
one escalated without producing an artifact. That is what it actually cost.

**"Can this sit inside a live member conversation?"**
Per capability, and the ledger says which. Balance lookup runs in about 6s and
belongs in a conversation. A transfer is 16.6s at p95 and probably wants a "let
me do that and come back to you". That distinction only became visible when the
ledger started reporting a percentile instead of a mean — the mean said 18s and
the p95 said 50.8s, and the gap turned out to be a 20-second stall on every
dropdown in the system. See ADAPTATION.md §5; the fix took the open-share flow
from 50.5s to 13.1s and sign-on from 23.6s to 4.8s.

**"How many of these can run at once?"**
Beat 5½ shows three. It is worth being asked, because it was broken until it was
measured: the counter that gates a capability's approval was incremented
in-memory, so twenty concurrent runs recorded as one. Sessions were always
isolated — that part was sound — but the governance record was not.
