// ─── Refund rules ───
// The rules a Student's Purchase must meet for them to raise a Refund Request.
// See GLOSSARY.md (Watch Limit, Completion Limit) and
// docs/adr/0002-progress-outlives-enrollment.md.

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

/** A rule that stops a Student raising a Refund Request. */
export type RuleBreak =
  | "window_closed"
  | "watched_too_much"
  | "completed_too_much"
  | "seat_claimed";
