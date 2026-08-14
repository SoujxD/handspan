/**
 * Seed data for the mock core-banking system.
 *
 * Every value here is synthetic. The SSN-shaped and card-shaped fields exist
 * specifically so the redaction pipeline has something real to catch — if a
 * capability ever leaks one into an artifact or a log, the tests fail.
 */

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  ssn: string; // synthetic, deliberately SSN-shaped
  dob: string;
  email: string;
  status: 'ACTIVE' | 'DORMANT' | 'RESTRICTED';
  accounts: Account[];
}

export interface Account {
  number: string;
  type: 'SAVINGS' | 'CHECKING' | 'MONEY_MARKET' | 'CERTIFICATE';
  nickname: string;
  balanceCents: number;
  openedOn: string;
}

export const MEMBERS: Member[] = [
  {
    id: '12345',
    firstName: 'Dana',
    lastName: 'Whitfield',
    ssn: '412-88-7301',
    dob: '1979-04-11',
    email: 'dana.whitfield@example.test',
    status: 'ACTIVE',
    accounts: [
      { number: '000123450001', type: 'SAVINGS', nickname: 'Primary Savings', balanceCents: 1843207, openedOn: '2011-06-02' },
      { number: '000123450002', type: 'CHECKING', nickname: 'Everyday Checking', balanceCents: 231944, openedOn: '2011-06-02' },
    ],
  },
  {
    id: '20881',
    firstName: 'Marcus',
    lastName: 'Ibarra',
    ssn: '509-22-6614',
    dob: '1966-11-30',
    email: 'marcus.ibarra@example.test',
    status: 'ACTIVE',
    accounts: [
      { number: '000208810001', type: 'SAVINGS', nickname: 'Share Savings', balanceCents: 5502310, openedOn: '2004-01-19' },
      { number: '000208810007', type: 'MONEY_MARKET', nickname: 'MM Reserve', balanceCents: 12750000, openedOn: '2018-09-05' },
    ],
  },
  {
    id: '33417',
    firstName: 'Priya',
    lastName: 'Raghunathan',
    ssn: '221-40-9987',
    dob: '1991-02-17',
    email: 'priya.r@example.test',
    // RESTRICTED members produce a permission denial on the detail screen. This
    // is a *business outcome*, not a crash — the replay contract must say so.
    status: 'RESTRICTED',
    accounts: [
      { number: '000334170001', type: 'SAVINGS', nickname: 'Share Savings', balanceCents: 91250, openedOn: '2020-03-11' },
    ],
  },
  {
    id: '77002',
    firstName: 'Eleanor',
    lastName: 'Vance',
    ssn: '333-19-4420',
    dob: '1954-08-23',
    email: 'e.vance@example.test',
    status: 'DORMANT',
    accounts: [
      { number: '000770020001', type: 'CERTIFICATE', nickname: '18mo CD', balanceCents: 2500000, openedOn: '2023-11-01' },
    ],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Per-tenant configuration. Both tenants run the *same underlying vendor
 * product* (this app) with different branding, labels, element ids, and one
 * behavioural difference (Lakeshore shows a daily notice interstitial).
 *
 * This is the stand-in for "hundreds of tenants, ~20 apps each, many sharing a
 * vendor product configured differently" from the brief.
 */
export interface TenantConfig {
  slug: string;
  displayName: string;
  vendorProduct: string;
  vendorVersion: string;
  accent: string;
  /** Label vocabulary differences — the thing that breaks naive name-matching. */
  labels: {
    memberId: string;
    searchButton: string;
    openSubAccount: string;
    nickname: string;
    initialDeposit: string;
    accountType: string;
    submitReview: string;
    confirmButton: string;
  };
  /** Element id prefix. Legacy apps rarely keep these stable across skins. */
  idPrefix: string;
  /** Lakeshore interposes a notice screen after login; Northstar does not. */
  showDailyNotice: boolean;
}

export const TENANTS: Record<string, TenantConfig> = {
  northstar: {
    slug: 'northstar',
    displayName: 'Northstar Community Credit Union',
    vendorProduct: 'meridian-core',
    vendorVersion: '8.4',
    accent: '#1b4f8a',
    labels: {
      memberId: 'Member ID',
      searchButton: 'Search',
      openSubAccount: 'Open Sub-Account',
      nickname: 'Account Nickname',
      initialDeposit: 'Initial Deposit',
      accountType: 'Account Type',
      submitReview: 'Continue to Review',
      confirmButton: 'Confirm and Open Account',
    },
    idPrefix: 'ctl00$MainContent$',
    showDailyNotice: false,
  },
  lakeshore: {
    slug: 'lakeshore',
    displayName: 'Lakeshore Federal Credit Union',
    vendorProduct: 'meridian-core',
    vendorVersion: '8.6',
    accent: '#1f6d4a',
    labels: {
      memberId: 'Member Number',
      searchButton: 'Find Member',
      openSubAccount: 'New Sub Account',
      nickname: 'Account Nickname',
      initialDeposit: 'Opening Deposit',
      accountType: 'Product Type',
      submitReview: 'Review Request',
      confirmButton: 'Submit and Open Account',
    },
    idPrefix: 'MainForm$Body$',
    showDailyNotice: true,
  },
};

export function tenantOf(slug: string): TenantConfig | undefined {
  return TENANTS[slug];
}

/** Injectable runtime conditions. Set via POST /__control/fault. */
export type FaultMode =
  | 'none'
  | 'validation'
  | 'unexpected_dialog'
  | 'session_timeout'
  | 'slow_load'
  | 'server_error';

export const FAULT_MODES: FaultMode[] = [
  'none',
  'validation',
  'unexpected_dialog',
  'session_timeout',
  'slow_load',
  'server_error',
];

export const runtimeState = {
  fault: 'none' as FaultMode,
  /** Confirmation counter so confirmation numbers are stable-ish but unique. */
  confirmationSeq: 4100,
};
