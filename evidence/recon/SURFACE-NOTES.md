# MERIDIAN CORE — surface notes

Recon pass against `https://web-sample.interface-hiring.com`, 2026-09-03, before
any capability was recorded. Everything below is **observed**, not remembered:
each error string was provoked and read off the page. That matters because a
detector written from remembered phrasing never matches and fails silently — on
this system's first outcome-verification pass against its own fixture app, 8 of
8 declared detectors were dead for exactly that reason.

Member data (names, e-mail, phone, address, balances) is redacted here the same
way it is everywhere else this system writes to disk. These are my own notes and
they get no exemption; that is the point of the guarantee.

## The product

`MERIDIAN CORE — Member Services Platform v4.2.1`, by
`Cornerstone Financial Systems™`. Server-rendered HTML, `<table>` layout,
`.fld` / `.btn` / `.lbl` class names, a numbered main menu, PF-key footer. No
test ids and no ARIA; links and buttons get an accessible name from their own
text, and every data-entry field has none at all (measured below).

**Naming collision, stated plainly:** the local fixture app in `target-app/`,
built for the take-home in August, is also called "Meridian Core" (v8.4). It is
a coincidence. The two are told apart by vendor and version — this target is
Cornerstone's Meridian Core 4.2.1; the fixture is Meridian Core 8.4, and its
artifacts are dated 2026-08-14, twelve days before this brief existed.

## Route map

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/` | GET | no | 302 to `/signon` |
| `/signon` | GET, POST | no | POST 302s to `/menu`, or back to `/signon?err=...` |
| `/menu` | GET | yes | numbered menu, options 1-5, 8, 9 |
| `/members` | GET | yes | search form: `by` = `number` or `name`, `q` |
| `/members/:id` | GET | yes | member record + shares grid + action links |
| `/members/:id/transfer` | GET | yes | form, POST `/transfer/review`, POST `/transfer/post` |
| `/members/:id/open-share` | GET | yes | form, POST `/open-share/review`, then post |
| `/members/:id/update` | GET, POST | yes | single screen, no review step |
| `/members/:id/hold` | GET | yes | form renders for a teller; **403 at review** |
| `/settings` | GET | yes | global error injection — **do not touch, app is shared** |
| `/signoff` | GET | yes | |

Session cookie is `MC_SID`, `HttpOnly`, `SameSite=Lax`.

## The hidden per-transaction token — answered

```html
<form method="post" action="/members/100234/transfer/review">
  <input type="hidden" name="_token" value="8896930f-3a5">
```

It is a plain hidden input inside the form, stable for the session (two
consecutive GETs returned the same value), and it is re-emitted on the review
screen alongside the posted field values.

**So there is nothing to read.** `perception.ts` drops `input[type=hidden]`
before the accessibility tree is built, which means the model never sees the
token and the resolver cannot target it — and clicking the real submit button
makes the browser carry it exactly as it does for a person at a keyboard.

Worth saying out loud: the per-transaction token is a genuinely hard problem for
an HTTP-level integration, and a non-problem for something that drives the UI
the way a human does. No `hiddenValue` node kind is needed.

## Label derivation - which rung fires

Measured, not guessed: `scripts/recon-meridian.ts` walks all 17 screens through
the real perception layer and counts `labelSource` per control.

| role | n | label source |
|---|---|---|
| link | 84 | **100%** accessible-name |
| button | 8 | **100%** accessible-name |
| textbox | 11 | **100%** table-cell |
| combobox | 8 | **100%** table-cell |

The split is total, and that is the interesting result. Anything with intrinsic
text - a link, a submit button - resolves on rung 1, because its text *is* its
accessible name. **Every data-entry field on the entire application is carried
by rung 3 alone:** all 19 of them, not one with an accessible name and not one
with a `<label for>`. The markup is uniformly

```html
<td class="lbl">From Share:</td><td><select name="from">...</select></td>
```

Without the adjacent-table-cell rung, no form on this app would be addressable
without selectors. It is the rung that exists for exactly this kind of app, and
this target is the first time it has had to carry a whole application alone.

An earlier draft of these notes, written from raw HTML before the perception
pass ran, claimed *no* control had an accessible name. That was wrong - true of
the fields, false of the buttons and links. The table above comes from the
layer that actually does the work, which is the only version worth quoting.

### The shares grid

Two-dimensional, and it arrives exactly as `fromTableCell`
(rowMatch x columnLabel) needs:

```
col=Balance  rowKey=100234-S0070  value='$1,240.55'
col=Status   rowKey=100234-S0070  value='HOLD [HOLD]'
```

So "the Balance of the row whose Share ID is 100234-S0070" is directly
addressable, named the way an operator says it. Two details to know before
writing an extraction rule:

- A cell's own text is in `value`. Its `label` is the *neighbouring* cell,
  which is meaningless inside a grid - which is precisely why the grid axes are
  separate fields rather than another rung of the label ladder.
- `columnHeader` is populated for layout tables too, where it is junk (the
  first cell of a presentational row). Trust it only where a real header row
  exists, as it does on the shares grid.

Recon reads 10 OPEN shares off that grid and uses two of them to drive the
transfer form through to its review screen. That is the same path the
capability will take: the share id is read from the member record, never
scraped from a combobox label that carries a balance.

### Resolver separation, measured

The two share pickers were the one place a tie looked plausible. Against the
live page, with 19 candidate controls in scope:

```
From Share   score 70, runner-up 30, matched [role,label]
To Share     score 70, runner-up 30, matched [role,label]
```

A 40-point margin against a required 12. No screen in the walk produced any
control pair sharing role + label + container.

## Comboboxes: option value vs. option label

The transfer form's options are:

```html
<option value="100234-S0001-19">100234-S0001-19 - Regular Shares ($100.00)</option>
```

The **value** is a clean share id; the **visible label carries a balance that
changes between runs**. Binding to the label would be non-deterministic by
construction.

No core change needed: `playwright-surface.ts` already tries
`selectOption({value})` first and falls back to `{label}`. That was written for
tenant skins months ago and happens to be exactly right here. The share id is a
typed capability input, so the artifact stores a `param` reference and replay
selects by value.

Open risk to settle in P1: perception exposes only the *selected* option's text,
so the discovery model cannot see option values. If it records the full visible
label instead of the id, replay will bind wrong. The first replay detects it
immediately; the fix, if one is needed, is to expose a combobox's options as
part of its observable state, which is generic.

## Review to post

Transfer and Open Share are two-phase; Update is single-screen with no review.

The review screen is a genuine checkpoint opportunity — it restates the
transaction before committing:

```
CONFIRM FUNDS TRANSFER
Member:  <member>
From:    <share> ($...)
To:      <share> ($...)
Amount:  $1.00
Memo:    demo
This will post immediately and cannot be reversed from this screen.
[Post Transfer]
```

So the capability asserts the review screen agrees with the typed inputs
*before* the post step runs. That turns "clicked two buttons" into "verified the
transaction it was about to commit matched the inputs it was given." A
disagreement is a checkpoint failure with expected/observed, not a retry.

Post confirmation:

```
TRANSFER POSTED
TRANSACTION COMPLETE
Confirmation:      CN480161
Posted:            09/03/2026 02:29:55
Amount:            $1.00
<from share>:      $... (new balance)
<to share>:        $... (new balance)
```

The confirmation number matches `CN\d{6}` and is extracted as a typed output via
`fromLabelledCell("Confirmation:", right)`. The success checkpoint is the
literal `TRANSACTION COMPLETE`.

## Exceptional states — verbatim, with status

Provoked per request with `?inject=<kind>`. The global System Settings screen
was **not** touched: the app is shared with other candidates and stateful in
memory, so a global fault setting would break someone else's demo.

| kind | HTTP | Heading | Body text | Affordance | Class |
|---|---|---|---|---|---|
| `validation` | 400 | `TRANSACTION REJECTED` | "The transaction could not be completed as entered. Please review the field values and resubmit." | Return to previous screen | business |
| `notfound` | 404 | `RECORD NOT FOUND` | "The requested member record could not be located on this host." | Return to Member Inquiry | business |
| `permission` | 403 | `SUPERVISOR OVERRIDE REQUIRED` | "Operator profile teller1 is not authorized to perform this function. A supervisor must sign on to complete this request." | Return to previous screen | **escalate** |
| `timeout` | 440 | `YOUR SESSION HAS TIMED OUT` | "NOT SIGNED ON" | — | **escalate** (see note) |
| `maintenance` | 503 | `SCHEDULED MAINTENANCE IN PROGRESS` | "The host is temporarily unavailable while nightly batch posting completes. This window normally clears within a few moments." | **`Continue` button** | recoverable (dismiss) |
| `server` | 500 | `APPLICATION ERROR` | "An unexpected error occurred while processing your request. Reference: ERR-406751F1" | Return to previous screen | hard |

Natural, non-injected errors:

| Condition | HTTP | Text | Class |
|---|---|---|---|
| Bad login | 302 | to `/signon?err=Invalid operator ID or password.` | business |
| No search match | 200 | "No member records matched your search." | business |
| Overdraw | 400 | "The transaction could not be validated:" / "Insufficient available balance in the source share." | business |
| Invalid e-mail | 400 | "Please correct the following:" / "E-mail address is not in a valid format." | business |
| Hold by teller | 403 | `SUPERVISOR OVERRIDE REQUIRED`, as above | escalate |

Three things this table settles:

1. **`maintenance` has a `Continue` button**, so the recoverable path is a
   `click` recovery — which the engine already verifies made progress before
   letting the step retry.
   *Note on `timeout`:* this table originally read `recoverable (re-auth)`,
   which was the intent before the engine was examined. There is no recovery
   kind that can re-run the sign-on steps — `restartFromStep` is deliberately
   unimplemented because restarting mid-flow can re-submit an already committed
   step — so it is classified `escalate` in every artifact. A recovery that
   discarded a half-filled form would be worse than stopping. ADAPTATION.md §5
   carries the design for the `runSteps` recovery that would close it.

2. **`timeout` actually destroys the session server-side.** It is not merely a
   rendered page: every subsequent request 302s to `/signon`. So recovery
   genuinely requires re-authentication, and the engine has no recovery kind
   that can re-run steps — `restartFromStep` is deliberately unimplemented. This
   is the one core edit this target forces, and it is generic.
3. **`permission` is `escalate`, not `hard`.** A permission denial has a human
   remedy, and the app says so in its own words: *"A supervisor must sign on."*
   The escalation path is described by the target itself.

## Statefulness — a live constraint, not a footnote

Member 100234 currently carries **19 shares**, most of them `HOLD`, with ids
like `100234-MMKT-16` — the residue of other candidates hammering the app. It
resets on redeploy, and it is shared right now.

Consequences, all design constraints rather than annoyances:

- No capability may assume a balance or a share list. Every one reads current
  state.
- `share_on_hold` is a real business outcome to declare, not a hypothetical —
  another candidate can put a hold on a share mid-demo.
- Share ids are typed inputs, which means the agent composes: look up the
  member's shares, then transfer between two of them. That is what a catalog an
  agent can invoke by name is *for*.
- Demo amounts are $1.00 between two of the member's own shares.

## Resolver ambiguity check

`From Share:` and `To Share:` are two comboboxes on one screen with identical
role and container, separated by label alone — a 40-point signal against a
12-point required margin, which is clean. The submit buttons are `Continue`
(review) and `Post Transfer` (commit), textually distinct. No ambiguity was
found that would tie under the resolver.

## Risk classification — settled by observation

The commit buttons are **`Post Transfer`** and, for hold, one reached only after
a 403. The current policy classifies `\b(transfer|wire|disburse|payment)\b` as
`irreversible`, which is blocked unconditionally — so Funds Transfer would be
refused before it ever ran.

Because the two buttons are textually distinct, the split can be expressed in
`policy.yaml` alone:

- **Funds Transfer becomes `confirmable`.** It runs unattended only with a
  per-invocation confirmation token naming the capability, and only from an
  approved artifact. Defensible: a transfer between a member's own shares is a
  routine teller action with a compensating correction available, and the risk
  being managed is executing the *wrong* one — which is what the confirmation
  token and the review checkpoint exist to catch.
- **Place Account Hold stays `irreversible`, supervisor-gated.** Blocked
  unconditionally for unattended replay. A teller attempting it escalates with
  full context.

No code change. This is a configuration edit, which is the claim.
