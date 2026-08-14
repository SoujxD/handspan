# Evidence — `member_savings_balance` v8

> Signs in to the Northstar (Meridian Core Servicing 8.4) back-office console with supplied teller credentials, searches Member Servicing for a given Member ID, and returns the current balance of that member's SAVINGS share along with the share account number, member name and member status. Reports "member not found" as a normal business result.

Discovered by **claude-opus-5** on 2026-08-14T20:37:06.142Z (discovery run `disc-20260814-203551-eb30cf`). Content hash `2b370fb1ba39b018c58779c37ab2e6cd`.

**Every replay below made 0 model calls.** That is the point of the artifact.

| # | Scenario | Result | Detail | Model calls | Evidence |
|---|---|---|---|---|---|
| 01 | **Happy path**<br><sub>The capability reaches its checkpoint and returns typed outputs.</sub> | `success` | savingsBalance=18432.07 savingsAccountNumber=000123450001 savingsNickname=Primary Savings memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-210404-5269ad`](./replay-20260814-210404-5269ad) |
| 02 | **Different input, same capability**<br><sub>Proves replay is parameterised rather than replaying memorised values.</sub> | `success` | savingsBalance=55023.1 savingsAccountNumber=000208810001 savingsNickname=Share Savings memberName=Ibarra, Marcus memberStatus=ACTIVE | 0 | [`replay-20260814-210410-ea2330`](./replay-20260814-210410-ea2330) |
| 03 | **Business outcome: no such member**<br><sub>A legitimate answer the caller needs. Reported as an outcome, exit code 0 — NOT a failure.</sub> | `outcome` | member_not_found | 0 | [`replay-20260814-210416-09fd79`](./replay-20260814-210416-09fd79) |
| 04 | **Business outcome: permission denied**<br><sub>A RESTRICTED record. Also an answer, not a crash.</sub> | `outcome` | member_access_restricted | 0 | [`replay-20260814-210442-9ec58a`](./replay-20260814-210442-9ec58a) |
| 05 | **Recoverable: unexpected interstitial**<br><sub>An advisory screen appears on every request. The engine dismisses it, verifies the recovery made progress, and continues.</sub> | `success` | savingsBalance=18432.07 savingsAccountNumber=000123450001 savingsNickname=Primary Savings memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-210508-0be544`](./replay-20260814-210508-0be544) |
| 06 | **Recoverable: degraded/slow application**<br><sub>Six seconds per request. Condition-based waiting rides it out where a fixed sleep would fail.</sub> | `success` | savingsBalance=18432.07 savingsAccountNumber=000123450001 savingsNickname=Primary Savings memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-210559-b5e376`](./replay-20260814-210559-b5e376) |
| 07 | **Hard failure: application server error**<br><sub>Classified as an application fault, with expected/observed and evidence pointers for debugging.</sub> | `failure` | surface_error | 0 | [`replay-20260814-210629-f0ddcb`](./replay-20260814-210629-f0ddcb) |
| 08 | **Rejected before touching the surface**<br><sub>A missing required input fails the declared contract at the boundary, not halfway through a flow.</sub> | `failure` | invalid_input | 0 | [`replay-20260814-210652-dc6312`](./replay-20260814-210652-dc6312) |
| 09 | **Cross-tenant reuse: lakeshore**<br><sub>Same artifact at a second institution running the same vendor product, via a label overlay. No re-recording.</sub> | `success` | savingsBalance=18432.07 savingsAccountNumber=000123450001 savingsNickname=Primary Savings memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-210653-c0ecfb`](./replay-20260814-210653-c0ecfb) |

Each evidence directory contains `run.jsonl` (structured log), `result.json`
(the full result contract), `scenario.json`, and — on failure — a screenshot,
a DOM dump, and the normalized accessibility snapshot the resolver was looking at.
