import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  CourseStatus,
  LessonProgressStatus,
  RefundRequestStatus,
  UserRole,
} from "~/db/schema";
import {
  findPurchaseToRefund,
  getRefundOffer,
  locateRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";
import type { Db } from "~/db";

const NOW = new Date("2026-11-15T12:00:00Z");
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

let db: Db;
let student: typeof schema.users.$inferSelect;
let course: typeof schema.courses.$inferSelect;
let lessonIds: number[];

function buy(daysAgo: number, amountPaid = 7900) {
  return db
    .insert(schema.purchases)
    .values({
      userId: student.id,
      courseId: course.id,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
}

function addSeat(purchaseId: number, code: string, claimed: boolean) {
  db.insert(schema.coupons)
    .values({
      teamId: 1,
      courseId: course.id,
      code,
      purchaseId,
      redeemedByUserId: claimed ? student.id : null,
      redeemedAt: claimed ? daysBefore(1) : null,
    })
    .run();
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });

  const instructor = db
    .insert(schema.users)
    .values({ name: "Sarah", email: "sarah@example.com", role: UserRole.Instructor })
    .returning()
    .get();
  student = db
    .insert(schema.users)
    .values({ name: "Liam", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  course = db
    .insert(schema.courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "intro-ts",
      description: "Learn TypeScript.",
      salesCopy: "Learn TypeScript.",
      instructorId: instructor.id,
      categoryId: category.id,
      price: 7900,
      status: CourseStatus.Published,
    })
    .returning()
    .get();
  const mod = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
  db.insert(schema.teams).values({}).run();
});

describe("raiseRefundRequest", () => {
  it("raises an Open Refund Request and builds the confirmation email", () => {
    const purchase = buy(3);

    const result = raiseRefundRequest(
      db,
      purchase.id,
      student.id,
      "Not what I expected.",
      NOW
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("individual");
    expect(result.email.to).toBe("liam@example.com");
    expect(result.email.body).toContain("$79.00");

    const saved = db
      .select()
      .from(schema.refundRequests)
      .where(eq(schema.refundRequests.id, result.refundRequestId))
      .get();
    expect(saved?.status).toBe(RefundRequestStatus.Open);
    expect(saved?.reason).toBe("Not what I expected.");
  });

  it("refuses a second Refund Request while one is Open", () => {
    const purchase = buy(3);
    raiseRefundRequest(db, purchase.id, student.id, "First ask.", NOW);

    const second = raiseRefundRequest(
      db,
      purchase.id,
      student.id,
      "Second ask.",
      NOW
    );

    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses someone else's Purchase", () => {
    const purchase = buy(3);
    expect(
      raiseRefundRequest(db, purchase.id, student.id + 99, "Mine now.", NOW)
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses once the fourteen-day window has closed", () => {
    const purchase = buy(15);
    expect(
      raiseRefundRequest(db, purchase.id, student.id, "Too late.", NOW)
    ).toMatchObject({ ok: false, status: 403, error: /window has closed/ });
  });

  it("refuses an Individual Purchase past the Completion Limit", () => {
    const purchase = buy(3);
    for (const lessonId of lessonIds.slice(0, 2)) {
      db.insert(schema.lessonProgress)
        .values({
          userId: student.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        })
        .run();
    }

    expect(
      raiseRefundRequest(db, purchase.id, student.id, "Half way.", NOW)
    ).toMatchObject({ ok: false, status: 403, error: /completed too much/ });
  });

  it("ignores the limits on a Team Licence, but refuses one with a Claimed Seat", () => {
    const purchase = buy(3, 7900 * 2);
    addSeat(purchase.id, "SEAT-1", false);
    addSeat(purchase.id, "SEAT-2", true);

    expect(
      raiseRefundRequest(db, purchase.id, student.id, "Team changed.", NOW)
    ).toMatchObject({ ok: false, status: 403, error: /Claimed Seat/ });
  });
});

describe("findPurchaseToRefund", () => {
  it("prefers the newest Individual Purchase over a newer Team Licence", () => {
    const individual = buy(5);
    const team = buy(2, 7900 * 3);
    addSeat(team.id, "SEAT-1", false);

    expect(findPurchaseToRefund(db, student.id, course.id)?.id).toBe(
      individual.id
    );
    expect(getRefundOffer(db, student.id, course.id, NOW)).toMatchObject({
      purchaseId: individual.id,
      amount: 7900,
    });
  });
});

describe("locateRefundRequest", () => {
  function raise() {
    const result = raiseRefundRequest(
      db,
      buy(3).id,
      student.id,
      "Not what I expected.",
      NOW
    );
    if (!result.ok) throw new Error(result.error);
    return result.refundRequestId;
  }

  it("finds an Open Refund Request's card on the Open queue", () => {
    const id = raise();
    expect(locateRefundRequest(db, id)).toBe(
      `/admin/refund-requests?status=open#refund-request-${id}`
    );
  });

  it("finds a decided Refund Request's card on the queue for its decision", () => {
    const id = raise();
    db.update(schema.refundRequests)
      .set({
        status: RefundRequestStatus.Declined,
        decidedAt: NOW.toISOString(),
      })
      .where(eq(schema.refundRequests.id, id))
      .run();

    expect(locateRefundRequest(db, id)).toBe(
      `/admin/refund-requests?status=declined#refund-request-${id}`
    );
  });

  it("finds nothing for a Refund Request that doesn't exist", () => {
    expect(locateRefundRequest(db, 999)).toBeNull();
  });
});