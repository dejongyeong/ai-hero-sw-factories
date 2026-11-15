import { describe, it, expect } from "vitest";
import { RefundRequestStatus } from "~/db/schema";
import {
  approvalBlocker,
  buildRefundDecisionEmail,
  declineBlocker,
  refundLimitWarnings,
  type DecisionContext,
} from "./refund-decisions";

const PLATFORM_ADMIN = 1;
const LEARNER = 2;

function openIndividualRequest(
  overrides: Partial<DecisionContext> = {}
): DecisionContext {
  return {
    status: RefundRequestStatus.Open,
    deciderUserId: PLATFORM_ADMIN,
    buyerUserId: LEARNER,
    purchaseKind: "individual",
    claimedSeatCount: 0,
    ...overrides,
  };
}

describe("refundLimitWarnings", () => {
  it("has nothing to say about a learner well under both limits", () => {
    expect(
      refundLimitWarnings({
        completedLessons: 1,
        totalLessons: 10,
        secondsWatched: 20 * 60,
      })
    ).toEqual([]);
  });

  it("warns once half the lessons are completed", () => {
    expect(
      refundLimitWarnings({
        completedLessons: 5,
        totalLessons: 10,
        secondsWatched: 0,
      })
    ).toHaveLength(1);
  });

  it("warns once two hours have been watched", () => {
    expect(
      refundLimitWarnings({
        completedLessons: 0,
        totalLessons: 10,
        secondsWatched: 2 * 60 * 60,
      })
    ).toHaveLength(1);
  });

  it("does not divide by zero for a course with no lessons", () => {
    expect(
      refundLimitWarnings({
        completedLessons: 0,
        totalLessons: 0,
        secondsWatched: 0,
      })
    ).toEqual([]);
  });
});

describe("approvalBlocker", () => {
  it("lets a Platform Admin approve someone else's Open request", () => {
    expect(approvalBlocker(openIndividualRequest())).toBeNull();
  });

  it("stops a Platform Admin approving their own request", () => {
    expect(
      approvalBlocker(openIndividualRequest({ buyerUserId: PLATFORM_ADMIN }))
    ).toMatch(/your own refund request/);
  });

  it("stops a second decision on a request already decided", () => {
    for (const status of [
      RefundRequestStatus.Approved,
      RefundRequestStatus.Declined,
    ]) {
      expect(approvalBlocker(openIndividualRequest({ status }))).toMatch(
        /already been decided/
      );
    }
  });

  it("lets a Team Purchase with no Claimed Seats be approved", () => {
    expect(
      approvalBlocker(openIndividualRequest({ purchaseKind: "team" }))
    ).toBeNull();
  });

  it("blocks a Team Purchase once any Seat is Claimed", () => {
    expect(
      approvalBlocker(
        openIndividualRequest({ purchaseKind: "team", claimedSeatCount: 1 })
      )
    ).toMatch(/1 Seat has been claimed/);
  });
});

describe("declineBlocker", () => {
  it("still lets a Team Purchase with Claimed Seats be declined", () => {
    expect(
      declineBlocker(
        openIndividualRequest({ purchaseKind: "team", claimedSeatCount: 3 })
      )
    ).toBeNull();
  });

  it("stops a Platform Admin declining their own request", () => {
    expect(
      declineBlocker(openIndividualRequest({ buyerUserId: PLATFORM_ADMIN }))
    ).toMatch(/your own refund request/);
  });
});

describe("buildRefundDecisionEmail", () => {
  const base = {
    recipientName: "Liam",
    recipientEmail: "liam@example.com",
    courseTitle: "Introduction to TypeScript",
    amount: 7900,
  };

  it("tells an approved learner the amount and that access has ended", () => {
    const email = buildRefundDecisionEmail({
      ...base,
      decision: RefundRequestStatus.Approved,
      purchaseKind: "individual",
    });
    expect(email.to).toBe("liam@example.com");
    expect(email.subject).toContain("approved");
    expect(email.body).toContain("$79.00");
    expect(email.body).toContain("no longer have access");
  });

  it("tells a Team Admin their Seat Codes no longer work", () => {
    const email = buildRefundDecisionEmail({
      ...base,
      decision: RefundRequestStatus.Approved,
      purchaseKind: "team",
    });
    expect(email.body).toContain("seat codes");
  });

  it("tells a declined learner they keep access", () => {
    const email = buildRefundDecisionEmail({
      ...base,
      decision: RefundRequestStatus.Declined,
      purchaseKind: "individual",
    });
    expect(email.subject).toContain("declined");
    expect(email.body).toContain("keep full access");
  });
});
