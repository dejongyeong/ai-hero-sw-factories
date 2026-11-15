import { RefundRequestStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// The limits a learner must stay under to raise a Refund Request. A Platform
// Admin sees them again when deciding, because Progress keeps growing while a
// Refund Request is Open. See docs/adr/0002-progress-outlives-enrollment.md.
export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type PurchaseKind = "individual" | "team";

export type RefundProgress = {
  completedLessons: number;
  totalLessons: number;
  secondsWatched: number;
};

/**
 * The refund limits this learner's Progress has reached. Shown to the
 * Platform Admin as warnings — they never block a decision, because the
 * Refund Request was valid when it was raised.
 */
export function refundLimitWarnings(progress: RefundProgress): string[] {
  const warnings: string[] = [];

  if (
    progress.totalLessons > 0 &&
    progress.completedLessons / progress.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    warnings.push(
      `Completed at least ${REFUND_COMPLETION_LIMIT * 100}% of the lessons.`
    );
  }

  if (progress.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    warnings.push(
      `Watched at least ${REFUND_WATCH_LIMIT_SECONDS / 3600} hours of video.`
    );
  }

  return warnings;
}

export type DecisionContext = {
  status: RefundRequestStatus;
  deciderUserId: number;
  /** Whoever made the Purchase — and so raised the Refund Request. */
  buyerUserId: number;
  purchaseKind: PurchaseKind;
  claimedSeatCount: number;
};

/** Why this Platform Admin cannot decide the request at all, or null. */
function decisionBlocker(context: DecisionContext): string | null {
  if (context.status !== RefundRequestStatus.Open) {
    return "This refund request has already been decided.";
  }
  if (context.deciderUserId === context.buyerUserId) {
    return "You cannot decide your own refund request. Another Platform Admin must decide it.";
  }
  return null;
}

/** Why this Platform Admin cannot approve the request, or null if they can. */
export function approvalBlocker(context: DecisionContext): string | null {
  const blocker = decisionBlocker(context);
  if (blocker) return blocker;

  // A Team Purchase with any Claimed Seat cannot be refunded — including a
  // Seat Claimed while the request was Open.
  // See docs/adr/0003-team-purchase-refunds-are-all-or-nothing.md.
  if (context.purchaseKind === "team" && context.claimedSeatCount > 0) {
    const seats = context.claimedSeatCount === 1 ? "Seat has" : "Seats have";
    return `${context.claimedSeatCount} ${seats} been claimed on this Team Purchase, so it cannot be refunded.`;
  }

  return null;
}

/** Why this Platform Admin cannot decline the request, or null if they can. */
export function declineBlocker(context: DecisionContext): string | null {
  return decisionBlocker(context);
}

/**
 * The email that tells whoever raised the Refund Request how it was decided.
 * There is no mail transport wired up yet, so it goes to the server log.
 */
export function buildRefundDecisionEmail(input: {
  decision: RefundRequestStatus.Approved | RefundRequestStatus.Declined;
  recipientName: string;
  recipientEmail: string;
  courseTitle: string;
  amount: number;
  purchaseKind: PurchaseKind;
}) {
  const approved = input.decision === RefundRequestStatus.Approved;

  const outcome = approved
    ? [
        `Your refund request for "${input.courseTitle}" has been approved. We will refund ${formatPrice(input.amount)}, the full amount you paid.`,
        "",
        input.purchaseKind === "team"
          ? "The seat codes from this purchase can no longer be used."
          : "You no longer have access to the course. Your progress is kept, so if you buy the course again you can pick up where you left off.",
      ]
    : [
        `Your refund request for "${input.courseTitle}" has been declined. You keep full access to the course.`,
      ];

  return {
    to: input.recipientEmail,
    subject: `Refund request ${approved ? "approved" : "declined"} — ${input.courseTitle}`,
    body: [
      `Hi ${input.recipientName},`,
      "",
      ...outcome,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
