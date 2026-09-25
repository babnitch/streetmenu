// PawaPay sandbox test data. No imports, no side effects — safe for the unit
// suites (fixtures.ts re-exports it for the DB/API suites).

// PawaPay SANDBOX test MSISDN for Cameroon, MTN (MTN_MOMO_CMR, XAF): a deposit
// from this number ends COMPLETED. From PawaPay's sandbox docs (2026-09-25).
// Sandbox API only — it is not a real wallet and means nothing in production.
// unit-pawapay-signature pins that detectMNO still routes it to MTN_MOMO_CMR.
export const PAWAPAY_SANDBOX_COMPLETED_CMR = '237653456789'
