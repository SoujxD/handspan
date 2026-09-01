/**
 * Deliberately hostile markup, modelled on real back-office core-banking UIs.
 *
 * What makes this a fair proxy for the real thing:
 *   - Table-based layout, nested 3 deep, no semantic landmarks.
 *   - ASP.NET WebForms-style control ids containing `$` (not a valid bare CSS
 *     identifier; naive `#id` selectors break on them).
 *   - Ids change between tenant skins, so any artifact that stores an id is
 *     dead on arrival at the second institution.
 *   - MOST form fields have no `<label for>`. Their only human-visible label is
 *     the text in the adjacent `<td>`. This is the single most important
 *     hostility: it means the accessible name is empty and a perception layer
 *     must derive a label from table structure.
 *   - The whole flow lives inside an iframe, so every locator has to traverse
 *     frames.
 *   - `<font>`, inline styles, spacer gifs' spiritual successors.
 *
 * Everything the automation needs is nonetheless visible to a human operator,
 * which is exactly the premise: if a person can do it, the system should too.
 */

import type { Member, TenantConfig } from './data.js';
import { containerLabel, formatUsd } from './data.js';

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Chrome for a page rendered *inside* the content frame. */
export function framePage(t: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<title>${esc(title)}</title>
<style>
  body { font-family: Verdana, Arial, sans-serif; font-size: 11px; margin: 0; padding: 8px; background: #f4f4f0; color: #222; }
  table { border-collapse: collapse; }
  table.frm td { padding: 3px 6px; font-size: 11px; }
  table.grid { border: 1px solid #999; background: #fff; }
  table.grid th { background: ${t.accent}; color: #fff; padding: 4px 8px; text-align: left; font-size: 11px; font-weight: normal; }
  table.grid td { border-bottom: 1px solid #ddd; padding: 4px 8px; }
  .panelhdr { background: ${t.accent}; color: #fff; padding: 4px 8px; font-weight: bold; font-size: 11px; }
  .panel { border: 1px solid #999; background: #fff; margin-bottom: 10px; }
  .panelbody { padding: 8px; }
  .err { background: #ffe9e9; border: 1px solid #c33; color: #900; padding: 6px 8px; margin-bottom: 8px; }
  .warn { background: #fff8e0; border: 1px solid #c93; color: #7a5200; padding: 6px 8px; margin-bottom: 8px; }
  .ok { background: #e9f7ec; border: 1px solid #3a3; color: #1a5c2a; padding: 6px 8px; margin-bottom: 8px; }
  input[type=text], input[type=password], select { font-family: Verdana, sans-serif; font-size: 11px; padding: 2px; border: 1px solid #888; }
  input[type=submit], button { font-family: Verdana, sans-serif; font-size: 11px; padding: 2px 10px; }
  a { color: ${t.accent}; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * The outer shell. A table-based header plus a content iframe — the flow all
 * happens one frame down, which is the common legacy shape (and the reason a
 * surface abstraction has to model frames as first-class).
 */
export function shell(t: TenantConfig, contentPath: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<title>${esc(t.displayName)} — Core Servicing</title>
<style>
  html, body { margin:0; padding:0; height:100%; font-family: Verdana, Arial, sans-serif; font-size: 11px; }
  #mainFrame { width:100%; height:calc(100% - 74px); border:0; }
</style>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="background:${t.accent};color:#fff;padding:10px 12px;">
      <font size="3"><b>${esc(t.displayName)}</b></font>
      <font size="1" color="#dfe8f5"> &nbsp;|&nbsp; Meridian Core Servicing ${esc(t.vendorVersion)}</font>
    </td>
    <td align="right" style="background:${t.accent};color:#fff;padding:10px 12px;">
      <font size="1">Signed in as <b>teller01</b> &nbsp; <a href="/t/${t.slug}/logout" style="color:#fff;">Sign Out</a></font>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="background:#e8e8e0;border-bottom:1px solid #aaa;padding:6px 12px;">
      <a href="/t/${t.slug}/home" target="mainFrame">Home</a> &nbsp;|&nbsp;
      <a href="/t/${t.slug}/member/search" target="mainFrame">Member Servicing</a> &nbsp;|&nbsp;
      <a href="/t/${t.slug}/admin" target="mainFrame">Administration</a>
    </td>
  </tr>
</table>
<iframe id="mainFrame" name="mainFrame" src="${esc(contentPath)}"></iframe>
</body>
</html>`;
}

export function loginPage(t: TenantConfig, error?: string): string {
  const p = t.idPrefix;
  return `<!DOCTYPE html>
<html><head><title>${esc(t.displayName)} — Sign In</title>
<style>
 body { font-family: Verdana, sans-serif; font-size:11px; background:#e8e8e0; padding:60px; }
 .box { background:#fff; border:1px solid #999; width:420px; margin:0 auto; }
 .hdr { background:${t.accent}; color:#fff; padding:8px 12px; font-weight:bold; }
 .err { background:#ffe9e9; border:1px solid #c33; color:#900; padding:6px 8px; margin:8px; }
 input { font-family:Verdana; font-size:11px; padding:3px; border:1px solid #888; }
</style></head>
<body>
<div class="box">
  <div class="hdr">${esc(t.displayName)} — Core Servicing Sign In</div>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="POST" action="/t/${t.slug}/login">
  <table class="frm" cellpadding="6" cellspacing="0" border="0" style="margin:12px;">
    <!-- Username has a proper label. Password does not. Real apps are exactly
         this inconsistent, and a locator strategy has to survive both. -->
    <tr>
      <td align="right"><label for="${p}txtUser">User ID</label></td>
      <td><input type="text" id="${p}txtUser" name="${p}txtUser" size="24"></td>
    </tr>
    <tr>
      <td align="right">Password</td>
      <td><input type="password" id="${p}txtPwd" name="${p}txtPwd" size="24"></td>
    </tr>
    <tr>
      <td></td>
      <td><input type="submit" name="${p}btnLogin" value="Sign In"></td>
    </tr>
  </table>
  </form>
</div>
</body></html>`;
}

export function dailyNoticePage(t: TenantConfig, next: string): string {
  return framePage(
    t,
    'Daily Notice',
    `<div class="panel">
   <div class="panelhdr">System Notice</div>
   <div class="panelbody">
     <div class="warn">
       <b>Scheduled maintenance window:</b> Saturday 02:00&ndash;04:00 CT. Batch posting may be delayed.
     </div>
     <p>Please acknowledge this notice to continue to the servicing console.</p>
     <form method="GET" action="${esc(next)}">
       <input type="submit" value="Acknowledge">
     </form>
   </div>
 </div>`,
  );
}

export function homePage(t: TenantConfig): string {
  return framePage(
    t,
    'Home',
    `<div class="panel">
   <div class="panelhdr">Servicing Console</div>
   <div class="panelbody">
     <p>Select a task to begin.</p>
     <table class="frm" cellpadding="4" border="0">
       <tr><td>&#187;</td><td><a href="/t/${t.slug}/member/search">Member Servicing &mdash; look up a member record</a></td></tr>
       <tr><td>&#187;</td><td><a href="/t/${t.slug}/admin">Administration &mdash; restricted</a></td></tr>
     </table>
   </div>
 </div>`,
  );
}

export function memberSearchPage(t: TenantConfig, error?: string): string {
  const p = t.idPrefix;
  return framePage(
    t,
    containerLabel('Member Search'),
    `<div class="panel">
   <div class="panelhdr">${esc(containerLabel('Member Search'))}</div>
   <div class="panelbody">
   ${error ? `<div class="err">${esc(error)}</div>` : ''}
   <form method="GET" action="/t/${t.slug}/member/results">
     <table class="frm" cellpadding="4" cellspacing="0" border="0">
       <tr>
         <!-- No <label for>. The only label is this adjacent cell's text.
              This is the case that defeats naive accessible-name matching. -->
         <td align="right" nowrap><b>${esc(t.labels.memberId)}</b></td>
         <td><input type="text" id="${p}txtMbr" name="mbr" size="18" maxlength="12"></td>
         <td><input type="submit" name="${p}btnFind" value="${esc(t.labels.searchButton)}"></td>
       </tr>
       <tr>
         <td align="right" nowrap>Last Name</td>
         <td colspan="2"><input type="text" id="${p}txtLast" name="last" size="24"></td>
       </tr>
     </table>
   </form>
   </div>
 </div>`,
  );
}

export function notFoundPage(t: TenantConfig, query: string): string {
  return framePage(
    t,
    containerLabel('Member Search'),
    `<div class="panel">
   <div class="panelhdr">${esc(containerLabel('Member Search'))}</div>
   <div class="panelbody">
     <!-- This is a legitimate business outcome, not an error page. It returns
          HTTP 200 on purpose: the caller needs "no such member", not a crash. -->
     <div class="warn">No member record found for <b>${esc(query)}</b>. Verify the number and try again.</div>
     <p><a href="/t/${t.slug}/member/search">Return to Member Search</a></p>
   </div>
 </div>`,
  );
}

export function permissionDeniedPage(t: TenantConfig, memberId: string): string {
  return framePage(
    t,
    'Access Restricted',
    `<div class="panel">
   <div class="panelhdr">Access Restricted</div>
   <div class="panelbody">
     <div class="err">
       <b>Authorization required.</b> Member ${esc(memberId)} is flagged <b>RESTRICTED</b>.
       Your role (Teller I) is not permitted to view this record. Contact a Branch Supervisor.
     </div>
     <p><a href="/t/${t.slug}/member/search">Return to Member Search</a></p>
   </div>
 </div>`,
  );
}

export function memberDetailPage(t: TenantConfig, m: Member): string {
  const rows = m.accounts
    .map(
      (a) => `<tr>
        <td nowrap>${esc(a.number)}</td>
        <td nowrap>${esc(a.type.replace('_', ' '))}</td>
        <td nowrap>${esc(a.nickname)}</td>
        <td nowrap align="right"><b>${esc(formatUsd(a.balanceCents))}</b></td>
        <td nowrap>${esc(a.openedOn)}</td>
      </tr>`,
    )
    .join('\n');

  return framePage(
    t,
    `Member ${m.id}`,
    `<div class="panel">
   <div class="panelhdr">Member Record &mdash; ${esc(m.id)}</div>
   <div class="panelbody">
     <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td valign="top">
       <table class="frm" cellpadding="3" border="0">
         <tr><td align="right" nowrap>Member Name</td><td><b>${esc(m.lastName)}, ${esc(m.firstName)}</b></td></tr>
         <tr><td align="right" nowrap>${esc(t.labels.memberId)}</td><td>${esc(m.id)}</td></tr>
         <tr><td align="right" nowrap>Status</td><td>${esc(m.status)}</td></tr>
         <tr><td align="right" nowrap>Date of Birth</td><td>${esc(m.dob)}</td></tr>
         <tr><td align="right" nowrap>Tax ID</td><td>${esc(m.ssn)}</td></tr>
         <tr><td align="right" nowrap>Email</td><td>${esc(m.email)}</td></tr>
       </table>
     </td></tr></table>
   </div>
 </div>

 <div class="panel">
   <div class="panelhdr">Share Accounts</div>
   <div class="panelbody">
     <table class="grid" cellpadding="0" cellspacing="0" border="0" width="100%">
       <tr><th>Account</th><th>Type</th><th>Nickname</th><th align="right">Current Balance</th><th>Opened</th></tr>
       ${rows}
     </table>
     <br>
     <form method="GET" action="/t/${t.slug}/member/${esc(m.id)}/subaccount/new">
       <input type="submit" value="${esc(t.labels.openSubAccount)}">
     </form>
   </div>
 </div>`,
  );
}

export function subAccountFormPage(
  t: TenantConfig,
  m: Member,
  errors: string[],
  prev: Record<string, string> = {},
): string {
  const p = t.idPrefix;
  const v = (k: string) => esc(prev[k] ?? '');
  return framePage(
    t,
    'Open Sub-Account',
    `<div class="panel">
   <div class="panelhdr">${esc(t.labels.openSubAccount)} &mdash; Member ${esc(m.id)}</div>
   <div class="panelbody">
     ${errors.length ? `<div class="err"><b>Please correct the following:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
     <form method="POST" action="/t/${t.slug}/member/${esc(m.id)}/subaccount/review">
       <table class="frm" cellpadding="4" cellspacing="0" border="0">
         <tr>
           <td align="right" nowrap><b>${esc(t.labels.accountType)}</b></td>
           <td>
             <select id="${p}ddlType" name="type">
               <option value="">-- select --</option>
               <option value="SAVINGS" ${prev['type'] === 'SAVINGS' ? 'selected' : ''}>Savings</option>
               <option value="CHECKING" ${prev['type'] === 'CHECKING' ? 'selected' : ''}>Checking</option>
               <option value="MONEY_MARKET" ${prev['type'] === 'MONEY_MARKET' ? 'selected' : ''}>Money Market</option>
               <option value="CERTIFICATE" ${prev['type'] === 'CERTIFICATE' ? 'selected' : ''}>Certificate</option>
             </select>
           </td>
         </tr>
         <tr>
           <td align="right" nowrap><b>${esc(t.labels.nickname)}</b></td>
           <td><input type="text" id="${p}txtNick" name="nickname" size="30" maxlength="40" value="${v('nickname')}"></td>
         </tr>
         <tr>
           <td align="right" nowrap><b>${esc(t.labels.initialDeposit)}</b></td>
           <td><input type="text" id="${p}txtAmt" name="amount" size="12" value="${v('amount')}"> <font size="1" color="#666">USD, minimum 25.00</font></td>
         </tr>
         <tr>
           <td></td>
           <td><input type="submit" name="${p}btnReview" value="${esc(t.labels.submitReview)}"></td>
         </tr>
       </table>
     </form>
   </div>
 </div>`,
  );
}

export function reviewPage(
  t: TenantConfig,
  m: Member,
  data: { type: string; nickname: string; amount: string },
): string {
  const p = t.idPrefix;
  return framePage(
    t,
    'Review Sub-Account Request',
    `<div class="panel">
   <div class="panelhdr">Review &mdash; ${esc(t.labels.openSubAccount)}</div>
   <div class="panelbody">
     <div class="warn">This will open a new account on the member's record. Review carefully before confirming.</div>
     <table class="grid" cellpadding="0" cellspacing="0" border="0">
       <tr><th>Field</th><th>Value</th></tr>
       <tr><td nowrap>Member</td><td nowrap>${esc(m.lastName)}, ${esc(m.firstName)} (${esc(m.id)})</td></tr>
       <tr><td nowrap>${esc(t.labels.accountType)}</td><td nowrap>${esc(data.type.replace('_', ' '))}</td></tr>
       <tr><td nowrap>${esc(t.labels.nickname)}</td><td nowrap>${esc(data.nickname)}</td></tr>
       <tr><td nowrap>${esc(t.labels.initialDeposit)}</td><td nowrap>$${esc(data.amount)}</td></tr>
     </table>
     <br>
     <form method="POST" action="/t/${t.slug}/member/${esc(m.id)}/subaccount/confirm">
       <input type="hidden" name="type" value="${esc(data.type)}">
       <input type="hidden" name="nickname" value="${esc(data.nickname)}">
       <input type="hidden" name="amount" value="${esc(data.amount)}">
       <input type="submit" name="${p}btnConfirm" value="${esc(t.labels.confirmButton)}">
       &nbsp;<a href="/t/${t.slug}/member/${esc(m.id)}">Cancel</a>
     </form>
   </div>
 </div>`,
  );
}

export function confirmationPage(
  t: TenantConfig,
  m: Member,
  data: { type: string; nickname: string; amount: string },
  confirmationNumber: string,
  accountNumber: string,
): string {
  return framePage(
    t,
    'Sub-Account Opened',
    `<div class="panel">
   <div class="panelhdr">Request Completed</div>
   <div class="panelbody">
     <div class="ok"><b>Sub-account opened successfully.</b></div>
     <table class="grid" cellpadding="0" cellspacing="0" border="0">
       <tr><th>Field</th><th>Value</th></tr>
       <tr><td nowrap>Confirmation Number</td><td nowrap><b>${esc(confirmationNumber)}</b></td></tr>
       <tr><td nowrap>New Account Number</td><td nowrap>${esc(accountNumber)}</td></tr>
       <tr><td nowrap>${esc(t.labels.accountType)}</td><td nowrap>${esc(data.type.replace('_', ' '))}</td></tr>
       <tr><td nowrap>${esc(t.labels.nickname)}</td><td nowrap>${esc(data.nickname)}</td></tr>
       <tr><td nowrap>Opening Deposit</td><td nowrap>$${esc(data.amount)}</td></tr>
     </table>
     <p><a href="/t/${t.slug}/member/${esc(m.id)}">Return to member record</a></p>
   </div>
 </div>`,
  );
}

export function unexpectedDialogPage(
  t: TenantConfig,
  actionPath: string,
  carryParams: Record<string, string> = {},
): string {
  // Two things this markup has to get right, both of which real interstitials
  // get right and a naive mock does not:
  //
  // 1. `ack` is a hidden input, NOT a query string on the action. A GET form
  //    discards the action URL's query string and replaces it with the
  //    serialised fields, so `action="/home?ack=1"` navigates to plain `/home`
  //    and the advisory re-appears forever.
  //
  // 2. The parameters of the request the advisory interrupted are carried
  //    forward. Dropping them would send the user back to a half-executed
  //    action — here, a member search with no member number — which is not how
  //    an interstitial behaves and would make the recovery path untestable.
  const hidden = Object.entries({ ...carryParams, ack: '1' })
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n       ');

  return framePage(
    t,
    'System Message',
    `<div class="panel">
   <div class="panelhdr">System Message</div>
   <div class="panelbody">
     <div class="warn"><b>Session advisory:</b> Your workstation profile was refreshed by an administrator.
     Acknowledge to continue.</div>
     <form method="GET" action="${esc(actionPath)}">
       ${hidden}
       <input type="submit" value="Continue">
     </form>
   </div>
 </div>`,
  );
}

export function sessionExpiredPage(t: TenantConfig): string {
  return framePage(
    t,
    'Session Expired',
    `<div class="panel">
   <div class="panelhdr">Session Expired</div>
   <div class="panelbody">
     <div class="err"><b>Your session has timed out.</b> Sign in again to continue.</div>
     <p><a href="/t/${t.slug}/login" target="_top">Return to Sign In</a></p>
   </div>
 </div>`,
  );
}

export function serverErrorPage(t: TenantConfig): string {
  return framePage(
    t,
    'Application Error',
    `<div class="panel">
   <div class="panelhdr">Application Error</div>
   <div class="panelbody">
     <div class="err"><b>Server Error in '/MeridianCore' Application.</b><br>
     Object reference not set to an instance of an object.<br>
     <font size="1">Correlation ID: MC-8841-EXC</font></div>
   </div>
 </div>`,
  );
}

export function adminPage(t: TenantConfig): string {
  return framePage(
    t,
    'Administration',
    `<div class="panel">
   <div class="panelhdr">Administration</div>
   <div class="panelbody">
     <div class="err">Restricted area. Automation must never reach this screen &mdash;
     it is excluded by the navigation allowlist in <b>policy.yaml</b>.</div>
     <form method="POST" action="/t/${t.slug}/admin/purge">
       <input type="submit" value="Purge Member Records">
     </form>
   </div>
 </div>`,
  );
}
