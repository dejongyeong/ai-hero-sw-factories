import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";
import type { Email } from "~/lib/mailer.server";
import { refundRequestQueueHref } from "~/lib/refund-request-links";
import {
  approvalBlocker,
  buildRefundDecisionEmail,
  declineBlocker,
  type PurchaseKind,
  type RefundProgress,
} from "~/lib/refund-decisions";
import {
  notifyRefundRequestDecided,
  type NotificationTransport,
} from "~/lib/notify.server";
import {
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  REFUND_WINDOW_DAYS,
  type RuleBreak,
} from "~/lib/refund-rules";

// ─── Refunds ───
// Raising a Refund Request: whether a Student may raise one on a Purchase, and
// raising it; and a Platform Admin deciding one on /admin/refund-requests. See
// GLOSSARY.md for the language and docs/adr/0001–0003 for why it works the
// way it does.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Purchase = typeof purchases.$inferSelect;

// ─── Calendar days ───

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function isWithinWindow(purchasedAtIso: string, on: Date): boolean {
  const day = calendarDay(on);
  return (
    day >= calendarDay(new Date(purchasedAtIso)) &&
    day <= lastDayOfWindow(purchasedAtIso)
  );
}

// ─── Purchases and Seats ───

function getPurchase(db: Db, purchaseId: number) {
  return db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
}

function getSeatCounts(db: Db, purchaseId: number) {
  const result = db
    .select({
      total: count(),
      claimed: sql<number>`count(${coupons.redeemedAt})`,
    })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();

  return { total: result?.total ?? 0, claimed: result?.claimed ?? 0 };
}

/**
 * There is no column saying which kind a Purchase is: a Team Licence is the
 * Purchase that has Seats, and every Team Licence has at least one.
 */
export function getPurchaseKind(db: Db, purchaseId: number): PurchaseKind {
  return getSeatCounts(db, purchaseId).total > 0 ? "team" : "individual";
}

function getRefundRequestWithStatus(
  db: Db,
  purchaseId: number,
  status: RefundRequestStatus
) {
  return db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, status)
      )
    )
    .get();
}

// ─── Progress ───

function getLessonIds(db: Db, courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/**
 * The Progress the Watch Limit and Completion Limit are measured against:
 * lessons completed, counted against the course as it is now, and Watched —
 * the furthest point reached in each lesson's video, added up.
 */
export function getRefundProgress(
  db: Db,
  userId: number,
  courseId: number
): RefundProgress {
  const lessonIds = getLessonIds(db, courseId);
  if (lessonIds.length === 0) {
    return { completedLessons: 0, totalLessons: 0, secondsWatched: 0 };
  }

  const completed = db
    .select({ total: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return {
    completedLessons: completed?.total ?? 0,
    totalLessons: lessonIds.length,
    secondsWatched: furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    ),
  };
}

// ─── Rules ───

/** What the Student is told when they can't raise a Refund Request. */
const RULE_BREAK_ERRORS: Record<RuleBreak, string> = {
  window_closed: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
  watched_too_much:
    "You have watched too much of this course to get a refund.",
  completed_too_much:
    "You have completed too much of this course to get a refund.",
  seat_claimed: "A Team Licence with a Claimed Seat cannot be refunded.",
};

/**
 * The rules a Purchase breaks today. The Watch Limit and Completion Limit
 * apply only to an Individual Purchase; a Team Licence is decided by its
 * Claimed Seats instead (docs/adr/0003).
 */
function findRuleBreaks(db: Db, purchase: Purchase, now: Date): RuleBreak[] {
  const breaks: RuleBreak[] = [];

  if (!isWithinWindow(purchase.createdAt, now)) {
    breaks.push("window_closed");
  }

  const seats = getSeatCounts(db, purchase.id);
  if (seats.total > 0) {
    if (seats.claimed > 0) breaks.push("seat_claimed");
    return breaks;
  }

  const progress = getRefundProgress(db, purchase.userId, purchase.courseId);

  if (progress.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    breaks.push("watched_too_much");
  }

  if (
    progress.totalLessons > 0 &&
    progress.completedLessons / progress.totalLessons >= REFUND_COMPLETION_LIMIT
  ) {
    breaks.push("completed_too_much");
  }

  return breaks;
}

// ─── Raising a Refund Request ───

export type Failure = { ok: false; status: 403 | 404 | 409; error: string };

type RefundCheck = { ok: true; purchase: Purchase } | Failure;

/**
 * Whether this Student may raise a Refund Request on this Purchase today.
 * Only the person who paid may, a Purchase has at most one Open Refund
 * Request, and an Approved one ends its refund story.
 */
export function checkRefundRequest(
  db: Db,
  purchaseId: number,
  buyerId: number,
  now: Date
): RefundCheck {
  const purchase = getPurchase(db, purchaseId);

  if (!purchase || purchase.userId !== buyerId) {
    return { ok: false, status: 404, error: "Purchase not found." };
  }

  if (getRefundRequestWithStatus(db, purchase.id, RefundRequestStatus.Open)) {
    return {
      ok: false,
      status: 409,
      error: "You already have an open refund request on this purchase.",
    };
  }

  if (
    getRefundRequestWithStatus(db, purchase.id, RefundRequestStatus.Approved)
  ) {
    return {
      ok: false,
      status: 409,
      error: "This purchase has already been refunded.",
    };
  }

  const [firstBreak] = findRuleBreaks(db, purchase, now);
  if (firstBreak) {
    return { ok: false, status: 403, error: RULE_BREAK_ERRORS[firstBreak] };
  }

  return { ok: true, purchase };
}

/**
 * The Purchase a Refund Request from the course page is about: the Student's
 * newest Individual Purchase of the course, or — for a Team Admin with none —
 * their newest Team Licence of it.
 */
export function findPurchaseToRefund(
  db: Db,
  buyerId: number,
  courseId: number
): Purchase | undefined {
  const newestFirst = db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, buyerId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .all();

  return (
    newestFirst.find(
      (purchase) => getPurchaseKind(db, purchase.id) === "individual"
    ) ?? newestFirst[0]
  );
}

export type RefundOffer = {
  purchaseId: number;
  amount: number;
  lastDayInWindow: string;
};

/**
 * What the course page offers a Student who wants their money back: their
 * newest Individual Purchase of the course, if it can be refunded today.
 */
export function getRefundOffer(
  db: Db,
  buyerId: number,
  courseId: number,
  now: Date
): RefundOffer | null {
  const purchase = findPurchaseToRefund(db, buyerId, courseId);
  if (!purchase || getPurchaseKind(db, purchase.id) !== "individual") {
    return null;
  }

  if (!checkRefundRequest(db, purchase.id, buyerId, now).ok) return null;

  // A Refund is always the full amount the Student paid.
  return {
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow: lastDayOfWindow(purchase.createdAt),
  };
}

export type RaiseResult =
  | { ok: true; refundRequestId: number; kind: PurchaseKind; email: Email }
  | Failure;

/**
 * Raises an Open Refund Request on a Purchase, and builds the confirmation
 * email for the caller to send.
 */
export function raiseRefundRequest(
  db: Db,
  purchaseId: number,
  buyerId: number,
  reason: string,
  now: Date
): RaiseResult {
  const check = checkRefundRequest(db, purchaseId, buyerId, now);
  if (!check.ok) return check;

  const { purchase } = check;
  const buyer = db.select().from(users).where(eq(users.id, buyerId)).get();
  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, purchase.courseId))
    .get();

  if (!buyer || !course) {
    return { ok: false, status: 404, error: "Purchase not found." };
  }

  const refundRequest = db
    .insert(refundRequests)
    .values({
      purchaseId: purchase.id,
      status: RefundRequestStatus.Open,
      reason,
      requestedAt: now.toISOString(),
    })
    .returning({ id: refundRequests.id })
    .get();

  return {
    ok: true,
    refundRequestId: refundRequest.id,
    kind: getPurchaseKind(db, purchase.id),
    email: {
      to: buyer.email,
      subject: `Refund requested — ${course.title}`,
      body: [
        `Hi ${buyer.name},`,
        "",
        `We have your refund request for "${course.title}".`,
        `If it is approved, your refund will be ${formatPrice(purchase.amountPaid)}, the full amount you paid.`,
        "",
        "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again once it has been decided.",
        "",
        "— The Cadence team",
      ].join("\n"),
    },
  };
}

/**
 * Where a Refund Request's card is on the admin queue now, under its current
 * status — or null if there is no such Refund Request. A link to a Refund
 * Request (refundRequestHref) is redirected here, so it still lands on the
 * card after the request is decided.
 */
export function locateRefundRequest(
  db: Db,
  refundRequestId: number
): string | null {
  const found = db
    .select({ status: refundRequests.status })
    .from(refundRequests)
    .where(eq(refundRequests.id, refundRequestId))
    .get();

  return found ? refundRequestQueueHref(refundRequestId, found.status) : null;
}

// ─── Deciding a Refund Request ───

/** Thrown inside the decision's transaction to roll it back. */
class DecisionRefused extends Error {}

export type DecideResult = { ok: true; email: Email | null } | Failure;

/**
 * A Platform Admin's decision on an Open Refund Request. Approving records the
 * Refund and ends an Individual Purchase's Enrollment. Once the decision has
 * committed, Refund Request approved or declined goes to the person who raised
 * it; a refused decision changes nothing and sends nothing. Returns the
 * decision email for the caller to send.
 */
export async function decideRefundRequest(
  db: Db,
  refundRequestId: number,
  deciderUserId: number,
  decision: RefundRequestStatus.Approved | RefundRequestStatus.Declined,
  transport?: NotificationTransport
): Promise<DecideResult> {
  const refundRequest = db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      buyerUserId: purchases.userId,
      courseId: purchases.courseId,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
  if (!refundRequest) {
    return { ok: false, status: 404, error: "Refund request not found." };
  }

  const purchaseKind = getPurchaseKind(db, refundRequest.purchaseId);
  const context = {
    status: refundRequest.status,
    deciderUserId,
    buyerUserId: refundRequest.buyerUserId,
    purchaseKind,
    claimedSeatCount: getSeatCounts(db, refundRequest.purchaseId).claimed,
  };
  const blocker =
    decision === RefundRequestStatus.Approved
      ? approvalBlocker(context)
      : declineBlocker(context);
  if (blocker) return { ok: false, status: 409, error: blocker };

  try {
    db.transaction((tx) => {
      // Only an Open request can be decided. Checking the status again here
      // stops two Platform Admins deciding the same request at once.
      const decided = tx
        .update(refundRequests)
        .set({
          status: decision,
          decidedAt: new Date().toISOString(),
          decidedByUserId: deciderUserId,
        })
        .where(
          and(
            eq(refundRequests.id, refundRequest.id),
            eq(refundRequests.status, RefundRequestStatus.Open)
          )
        )
        .returning({ id: refundRequests.id })
        .get();

      if (!decided) {
        throw new DecisionRefused(
          "This refund request has already been decided."
        );
      }

      if (decision === RefundRequestStatus.Declined) return;

      // A Seat could have been Claimed since the check above.
      if (purchaseKind === "team") {
        const claimedNow = tx
          .select({ id: coupons.id })
          .from(coupons)
          .where(
            and(
              eq(coupons.purchaseId, refundRequest.purchaseId),
              isNotNull(coupons.redeemedAt)
            )
          )
          .get();
        if (claimedNow) {
          throw new DecisionRefused(
            "A Seat has been claimed on this Team Licence, so it cannot be refunded."
          );
        }
      }

      // A Refund is always the full amount paid.
      tx.insert(refunds)
        .values({
          refundRequestId: refundRequest.id,
          amount: refundRequest.amountPaid,
        })
        .run();

      // The Enrollment ends now; the Student's Progress is kept.
      // See docs/adr/0001-enrollment-ends-at-approval.md. A Team Admin is not
      // enrolled by a Team Licence, so there is nothing to end for one — its
      // Unclaimed Seats are refused at Claim time instead.
      if (purchaseKind === "individual") {
        tx.delete(enrollments)
          .where(
            and(
              eq(enrollments.userId, refundRequest.buyerUserId),
              eq(enrollments.courseId, refundRequest.courseId)
            )
          )
          .run();
      }
    });
  } catch (error) {
    if (error instanceof DecisionRefused) {
      return { ok: false, status: 409, error: error.message };
    }
    throw error;
  }

  // Refund Request approved or declined, in the Feed, only once the decision
  // has committed: a refused decision returns above and sends nothing. Never
  // throws, so a failed trigger leaves the decision standing.
  await notifyRefundRequestDecided(db, refundRequest.id, transport);

  const recipient = db
    .select()
    .from(users)
    .where(eq(users.id, refundRequest.buyerUserId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, refundRequest.courseId))
    .get();

  return {
    ok: true,
    email:
      recipient && course
        ? buildRefundDecisionEmail({
            decision,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
            courseTitle: course.title,
            amount: refundRequest.amountPaid,
            purchaseKind,
          })
        : null,
  };
}