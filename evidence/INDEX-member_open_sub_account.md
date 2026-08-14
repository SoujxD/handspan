# Evidence — `member_open_sub_account` v5

> Signs in to the Meridian core servicing console, looks up a member by member ID, and opens a new share sub-account with the given account type, nickname and opening deposit, confirming through the review screen. Returns the confirmation number, new account number, account type, nickname and opening deposit from the confirmation screen. If the member ID does not exist, returns the no_member_found business outcome instead.

Discovered by **claude-opus-5** on 2026-08-14T07:37:00.951Z (discovery run `disc-20260814-073435-418498`). Content hash `4af35f71d937f918264c13aed502c9ff`.

**Every replay below made 0 model calls.** That is the point of the artifact.

| # | Scenario | Result | Detail | Model calls | Evidence |
|---|---|---|---|---|---|
| 01 | **Happy path**<br><sub>The capability reaches its checkpoint and returns typed outputs.</sub> | `success` | confirmationNumber=MC-4111 newAccountNumber=0001123454111 accountTypeOpened=SAVINGS nicknameOpened=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-175233-83f289`](./replay-20260814-175233-83f289) |
| 02 | **Different input, same capability**<br><sub>Proves replay is parameterised rather than replaying memorised values.</sub> | `success` | confirmationNumber=MC-4112 newAccountNumber=0001208814112 accountTypeOpened=SAVINGS nicknameOpened=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-175303-e23940`](./replay-20260814-175303-e23940) |
| 03 | **Business outcome: no such member**<br><sub>A legitimate answer the caller needs. Reported as an outcome, exit code 0 — NOT a failure.</sub> | `outcome` | no_member_found | 0 | [`replay-20260814-175334-796e5e`](./replay-20260814-175334-796e5e) |
| 04 | **Business outcome: permission denied**<br><sub>A RESTRICTED record. Also an answer, not a crash.</sub> | `outcome` | member_access_restricted | 0 | [`replay-20260814-175400-cc8957`](./replay-20260814-175400-cc8957) |
| 05 | **Recoverable: unexpected interstitial**<br><sub>An advisory screen appears on every request. The engine dismisses it, verifies the recovery made progress, and continues.</sub> | `failure` | target_not_found | 0 | [`replay-20260814-175426-5defc9`](./replay-20260814-175426-5defc9) |
| 06 | **Recoverable: degraded/slow application**<br><sub>Six seconds per request. Condition-based waiting rides it out where a fixed sleep would fail.</sub> | `success` | confirmationNumber=MC-4113 newAccountNumber=0001123454113 accountTypeOpened=SAVINGS nicknameOpened=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-175623-814f7b`](./replay-20260814-175623-814f7b) |
| 07 | **Hard failure: application server error**<br><sub>Classified as an application fault, with expected/observed and evidence pointers for debugging.</sub> | `failure` | surface_error | 0 | [`replay-20260814-175735-79d040`](./replay-20260814-175735-79d040) |
| 08 | **Rejected before touching the surface**<br><sub>A missing required input fails the declared contract at the boundary, not halfway through a flow.</sub> | `failure` | invalid_input | 0 | [`replay-20260814-175758-fb385d`](./replay-20260814-175758-fb385d) |

Each evidence directory contains `run.jsonl` (structured log), `result.json`
(the full result contract), `scenario.json`, and — on failure — a screenshot,
a DOM dump, and the normalized accessibility snapshot the resolver was looking at.
