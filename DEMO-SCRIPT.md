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

> Windows note: run these from Git Bash with `MSYS_NO_PATHCONV=1` set, or it
> rewrites `/signon` into a Windows path. The allowlist catches it, which is
> reassuring but not what you want live.

---

## 1 · The whole loop, in thirty seconds  *(Chat tab)*

> **What is the balance of share 100234-S0001 for member 100234?**

One model call picks a capability and binds arguments. The run itself makes
**zero**. Switch to Runs and it is there: 7 steps, ~6s, `llmCalls 0`.

*Say:* "The model chose which capability to call. It did not decide a single
click — those were recorded once and reviewed."

---

## 2 · An answer, not a crash  *(Chat tab)*

> **What is the balance for member 999999?**

Comes back as a **business outcome**, HTTP **200**, exit code 0.

*Say:* "'No such member' is an answer. A caller that retries on non-2xx must not
retry it forever, and a dashboard must not count it as an error. That is why the
result contract has four shapes rather than success-or-error."

---

## 3 · Moving money, and who is allowed to authorise it  *(Chat tab)*

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

**If a share has been put on HOLD by another candidate**, you get the
`source_share_on_hold` business outcome instead — which is a *better* beat. Take
it: "the app changed underneath us and the capability reported it as an answer."
Fresh open shares:

```bash
curl -s -c /tmp/j -b /tmp/j -o /dev/null https://web-sample.interface-hiring.com/signon
curl -s -c /tmp/j -b /tmp/j -o /dev/null -X POST https://web-sample.interface-hiring.com/signon --data "operator=teller1&password=password"
curl -s -b /tmp/j https://web-sample.interface-hiring.com/members/100234 | grep -o '100234-[A-Za-z0-9-]*' | head
```

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

Operator console: `http://localhost:4400`.

Ask it through the **chatbot** too — it is refused before anything starts,
because an unattended invocation of a `draft` capability is not permitted. Two
independent gates, one demo.

---

## 6 · The closing argument  *(Adaptation ledger tab)*

```bash
npx tsx scripts/adaptation-report.ts
```

> 330 lines of configuration. 292 lines of core, every line listed so you can
> check that each is generic. $10.30 and nine discovery runs for seven
> capabilities. **Zero model calls across 53 replays.**

*Say:* "The headline is deliberately not 'zero core changes'. A core that needed
no changes is equally consistent with a core too thin to be stressed. The claim
I will defend is *N generic core edits, zero target-specific ones* — because
generic edits amortise across every app you onboard, and target-specific ones
never do. The one genuine coupling I found is in there too: the CLI used to
import its institution list from the mock application's own module."

---

## Backup, if the network misbehaves

Everything above already happened and is on disk:

```bash
npx tsx scripts/audit-evidence.ts     # PII audit across all persisted evidence
npx vitest run                        # 105 tests
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
The ledger is the answer, with the rework left in: three of those nine runs
re-recorded one capability while I was fixing compiler and redaction bugs, and
one escalated without producing an artifact. That is what it actually cost.
