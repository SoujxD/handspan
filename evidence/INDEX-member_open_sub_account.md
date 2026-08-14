# Evidence — `member_open_sub_account` v5

> Signs in to the Meridian core servicing console, looks up a member by Member ID, and opens a new share sub-account with the given account type, nickname and opening deposit, confirming through the review step. Returns the confirmation number, the new account number and the recorded type/nickname/deposit. If the member id does not exist, or the deposit is below the institution minimum, that is reported as a business outcome instead of an account being opened. Note: confirming is an irreversible change to the member record.

Discovered by **claude-opus-5** on 2026-08-14T21:32:35.672Z (discovery run `disc-20260814-213001-926de7`). Content hash `7b26c84745f76f14b4900457f2537ef8`.

**Every replay below made 0 model calls.** That is the point of the artifact.

| # | Scenario | Result | Detail | Model calls | Evidence |
|---|---|---|---|---|---|
| 01 | **Happy path**<br><sub>The capability reaches its checkpoint and returns typed outputs.</sub> | `success` | confirmationNumber=MC-4106 newAccountNumber=0001123454106 openedAccountType=SAVINGS openedNickname=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-214322-5990f7`](./replay-20260814-214322-5990f7) |
| 02 | **Different input, same capability**<br><sub>Proves replay is parameterised rather than replaying memorised values.</sub> | `success` | confirmationNumber=MC-4107 newAccountNumber=0001208814107 openedAccountType=SAVINGS openedNickname=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-214353-7eed95`](./replay-20260814-214353-7eed95) |
| 03 | **Business outcome: no such member**<br><sub>A legitimate answer the caller needs. Reported as an outcome, exit code 0 — NOT a failure.</sub> | `outcome` | member_not_found | 0 | [`replay-20260814-214424-35bbb1`](./replay-20260814-214424-35bbb1) |
| 04 | **Business outcome: permission denied**<br><sub>A RESTRICTED record. Also an answer, not a crash.</sub> | `outcome` | member_access_restricted | 0 | [`replay-20260814-214449-b4aea1`](./replay-20260814-214449-b4aea1) |
| 05 | **Recoverable: unexpected interstitial**<br><sub>An advisory screen appears on every request. The engine dismisses it, verifies the recovery made progress, and continues.</sub> | `failure` | target_not_found | 0 | [`replay-20260814-214515-f7b75c`](./replay-20260814-214515-f7b75c) |
| 06 | **Recoverable: degraded/slow application**<br><sub>Six seconds per request. Condition-based waiting rides it out where a fixed sleep would fail.</sub> | `success` | confirmationNumber=MC-4108 newAccountNumber=0001123454108 openedAccountType=SAVINGS openedNickname=Vacation Fund openingDepositPosted=250 | 0 | [`replay-20260814-214711-6ad6f6`](./replay-20260814-214711-6ad6f6) |
| 07 | **Hard failure: application server error**<br><sub>Classified as an application fault, with expected/observed and evidence pointers for debugging.</sub> | `failure` | surface_error | 0 | [`replay-20260814-214823-78a94c`](./replay-20260814-214823-78a94c) |
| 08 | **Rejected before touching the surface**<br><sub>A missing required input fails the declared contract at the boundary, not halfway through a flow.</sub> | `failure` | invalid_input | 0 | [`replay-20260814-214847-8037db`](./replay-20260814-214847-8037db) |

Each evidence directory contains `run.jsonl` (structured log), `result.json`
(the full result contract), `scenario.json`, and — on failure — a screenshot,
a DOM dump, and the normalized accessibility snapshot the resolver was looking at.
