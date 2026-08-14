# Evidence — `member_savings_balance_lookup` v6

> Signs in to the Meridian Core Servicing console for the institution, searches Member Servicing for a given member number, and returns the member's name, status, and the current balance of their SAVINGS share account (plus the savings account number). If no member record exists for the number supplied, returns the business outcome member_not_found instead.

Discovered by **claude-opus-5** on 2026-08-14T06:44:43.918Z (discovery run `disc-20260814-064328-08afad`). Content hash `3d28094759de664eef8f89c6fe7f7236`.

**Every replay below made 0 model calls.** That is the point of the artifact.

| # | Scenario | Result | Detail | Model calls | Evidence |
|---|---|---|---|---|---|
| 01 | **Happy path**<br><sub>The capability reaches its checkpoint and returns typed outputs.</sub> | `success` | savingsCurrentBalance=18432.07 savingsAccountNumber=000123450001 memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-174912-9f1112`](./replay-20260814-174912-9f1112) |
| 02 | **Different input, same capability**<br><sub>Proves replay is parameterised rather than replaying memorised values.</sub> | `success` | savingsCurrentBalance=55023.1 savingsAccountNumber=000208810001 memberName=Ibarra, Marcus memberStatus=ACTIVE | 0 | [`replay-20260814-174918-b1895a`](./replay-20260814-174918-b1895a) |
| 03 | **Business outcome: no such member**<br><sub>A legitimate answer the caller needs. Reported as an outcome, exit code 0 — NOT a failure.</sub> | `outcome` | member_not_found | 0 | [`replay-20260814-174924-755771`](./replay-20260814-174924-755771) |
| 04 | **Business outcome: permission denied**<br><sub>A RESTRICTED record. Also an answer, not a crash.</sub> | `outcome` | member_access_restricted | 0 | [`replay-20260814-174950-41b909`](./replay-20260814-174950-41b909) |
| 05 | **Recoverable: unexpected interstitial**<br><sub>An advisory screen appears on every request. The engine dismisses it, verifies the recovery made progress, and continues.</sub> | `success` | savingsCurrentBalance=18432.07 savingsAccountNumber=000123450001 memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-175016-760da1`](./replay-20260814-175016-760da1) |
| 06 | **Recoverable: degraded/slow application**<br><sub>Six seconds per request. Condition-based waiting rides it out where a fixed sleep would fail.</sub> | `success` | savingsCurrentBalance=18432.07 savingsAccountNumber=000123450001 memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-175107-addeef`](./replay-20260814-175107-addeef) |
| 07 | **Hard failure: application server error**<br><sub>Classified as an application fault, with expected/observed and evidence pointers for debugging.</sub> | `failure` | surface_error | 0 | [`replay-20260814-175136-1b6c17`](./replay-20260814-175136-1b6c17) |
| 08 | **Rejected before touching the surface**<br><sub>A missing required input fails the declared contract at the boundary, not halfway through a flow.</sub> | `failure` | invalid_input | 0 | [`replay-20260814-175200-4a3e1d`](./replay-20260814-175200-4a3e1d) |
| 09 | **Cross-tenant reuse: lakeshore**<br><sub>Same artifact at a second institution running the same vendor product, via a label overlay. No re-recording.</sub> | `success` | savingsCurrentBalance=18432.07 savingsAccountNumber=000123450001 memberName=Whitfield, Dana memberStatus=ACTIVE | 0 | [`replay-20260814-175201-793cf5`](./replay-20260814-175201-793cf5) |

Each evidence directory contains `run.jsonl` (structured log), `result.json`
(the full result contract), `scenario.json`, and — on failure — a screenshot,
a DOM dump, and the normalized accessibility snapshot the resolver was looking at.
