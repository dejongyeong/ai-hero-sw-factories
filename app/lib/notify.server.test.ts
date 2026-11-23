import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  CourseStatus,
  RefundRequestStatus,
  RefundStatus,
  TeamMemberRole,
  UserRole,
} from "~/db/schema";
import type { Db } from "~/db";
import { createTestDb } from "~/test/setup";
import { postComment } from "./comments.server";
import { decideRefundRequest, raiseRefundRequest } from "./refunds.server";
import type { NotificationWorkflow } from "./notifications";
import {
  archiveCommentNotifications,
  knockTransport,
  notifyCommentPosted,
  notifyNewPurchase,
  notifyRefundFailed,
  notifyRefundIssued,
  notifyRefundRequestDecided,
  notifyRefundRequestRaised,
  outboxTransport,
  type DeletedComment,
  type KnockClient,
  type KnockMessagesApi,
  type NotificationCancel,
  type NotificationTransport,
  type NotificationTrigger,
} from "./notify.server";

type Recorded = { workflowKey: NotificationWorkflow } & NotificationTrigger;

/** Records what it is asked to do. */
function recordingTransport() {
  const triggers: Recorded[] = [];
  const archived: DeletedComment[] = [];
  const cancelled: NotificationCancel[] = [];
  const transport: NotificationTransport = {
    async trigger(workflowKey, trigger) {
      triggers.push({ workflowKey, ...trigger });
    },
    async cancel(request) {
      cancelled.push(request);
    },
    async archiveMessages(comment) {
      archived.push(comment);
    },
  };
  return { transport, triggers, archived, cancelled };
}

const failing: NotificationTransport = {
  async trigger() {
    throw new Error("Knock is down");
  },
  async cancel() {
    throw new Error("Knock is down");
  },
  async archiveMessages() {
    throw new Error("Knock is down");
  },
};

type StoredMessage = {
  id: string;
  source: string;
  /** Knock's merged data: for a batch, the newest trigger's values win. */
  data: Record<string, unknown>;
  activities: { data: Record<string, unknown> }[];
  recipient?: string;
  archived_at?: string | null;
};

/**
 * Knock's messages API, as far as the archive uses it, over a fixed store.
 * Like Knock's, its list includes archived messages.
 */
function fakeKnockMessages(stored: StoredMessage[]) {
  const archivedBatches: string[][] = [];
  // Knock's trigger_data filter matches top-level scalar values only.
  const matches = (data: Record<string, unknown>, filter?: string) =>
    !filter ||
    Object.entries(JSON.parse(filter)).every(([k, v]) => data[k] === v);
  const messages: KnockMessagesApi = {
    async *list(query) {
      for (const message of stored) {
        if (query.source && message.source !== query.source) continue;
        if (matches(message.data, query.trigger_data)) {
          yield {
            id: message.id,
            recipient: message.recipient ?? "cadence-1",
            archived_at: message.archived_at ?? null,
          };
        }
      }
    },
    async *listActivities(messageId) {
      yield* stored.find((m) => m.id === messageId)?.activities ?? [];
    },
    batch: {
      async archive({ message_ids }) {
        archivedBatches.push(message_ids);
      },
    },
  };
  const knock: KnockClient = {
    workflows: {
      async cancel() {},
    } as unknown as KnockClient["workflows"],
    messages,
  };
  return { knock, archivedBatches };
}

let db: Db;
let student: typeof schema.users.$inferSelect;
let otherStudent: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let lessonId: number;
let courseId: number;

beforeEach(() => {
  db = createTestDb();

  instructor = db
    .insert(schema.users)
    .values({
      name: "Sarah",
      email: "sarah@example.com",
      role: UserRole.Instructor,
    })
    .returning()
    .get();
  student = db
    .insert(schema.users)
    .values({ name: "Liam", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get();
  otherStudent = db
    .insert(schema.users)
    .values({ name: "Maya", email: "maya@example.com", role: UserRole.Student })
    .returning()
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
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
  courseId = course.id;
  const courseModule = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: courseModule.id, title: "Generics", position: 1 })
    .returning()
    .get().id;
});

describe("notifyCommentPosted: Comment reply", () => {
  it("sends Comment reply to the author of the parent Comment", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      instructor.id,
      lessonId,
      question.id,
      "Because."
    );
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, reply.id, transport);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].workflowKey).toBe("comment-reply");
    expect(triggers[0].recipients).toEqual([
      { id: `cadence-${student.id}`, name: "Liam", email: "liam@example.com" },
    ]);
    expect(triggers[0].data).toMatchObject({ comment_id: reply.id });
  });

  it("sends Comment reply for a Reply by another Student too", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      otherStudent.id,
      lessonId,
      question.id,
      "Same here."
    );
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, reply.id, transport);

    expect(triggers.map((t) => t.recipients.map((r) => r.id))).toEqual([
      [`cadence-${student.id}`],
    ]);
  });

  it("sends nothing for a Reply to one's own Comment", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      student.id,
      lessonId,
      question.id,
      "Never mind."
    );
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, reply.id, transport);

    expect(triggers).toEqual([]);
  });

  it("carries only the Reply id and what the Feed needs to link to it", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      instructor.id,
      lessonId,
      question.id,
      "Because."
    );
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, reply.id, transport);

    expect(triggers[0].data).toEqual({
      comment_id: reply.id,
      actor_name: "Sarah",
      lesson_title: "Generics",
      url: `/courses/intro-ts/lessons/${lessonId}#comment-${reply.id}`,
    });
  });

  it("does not throw when the transport fails", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      instructor.id,
      lessonId,
      question.id,
      "Because."
    );
    await expect(
      notifyCommentPosted(db, reply.id, failing)
    ).resolves.toBeUndefined();
  });
});

describe("notifyCommentPosted: New question", () => {
  it("sends New question to the course's owning Instructor", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, question.id, transport);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].workflowKey).toBe("new-question");
    expect(triggers[0].recipients).toEqual([
      {
        id: `cadence-${instructor.id}`,
        name: "Sarah",
        email: "sarah@example.com",
      },
    ]);
  });

  it("sends nothing for a top-level Comment by the course's Instructor", async () => {
    const post = postComment(db, instructor.id, lessonId, null, "Welcome!");
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, post.id, transport);

    expect(triggers).toEqual([]);
  });

  it("sends nothing for a top-level Comment by a Platform Admin", async () => {
    const admin = db
      .insert(schema.users)
      .values({
        name: "Ada",
        email: "ada@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const post = postComment(db, admin.id, lessonId, null, "Heads up.");
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, post.id, transport);

    expect(triggers).toEqual([]);
  });

  it("sends Comment reply, not New question, for a Reply", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      otherStudent.id,
      lessonId,
      question.id,
      "Same here."
    );
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, reply.id, transport);

    expect(triggers.map((t) => t.workflowKey)).toEqual(["comment-reply"]);
  });

  it("carries the Question and its lesson, the batch key, and a link to it", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, question.id, transport);

    expect(triggers[0].actor).toEqual({
      id: `cadence-${student.id}`,
      name: "Liam",
      email: "liam@example.com",
    });
    expect(triggers[0].data).toEqual({
      comment_id: question.id,
      lesson_id: lessonId,
      actor_name: "Liam",
      lesson_title: "Generics",
      url: `/courses/intro-ts/lessons/${lessonId}#comment-${question.id}`,
    });
  });

  it("can be cancelled by the Question's id while its batch is open", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyCommentPosted(db, question.id, transport);

    expect(triggers[0].cancellationKey).toBe(`comment-${question.id}`);
  });
});

describe("archiveCommentNotifications", () => {
  it("archives every Notification about the deleted Comment, for every recipient", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, archived } = recordingTransport();

    await archiveCommentNotifications(db, question.id, transport);

    expect(archived).toEqual([
      { comment_id: question.id, lesson_id: lessonId },
    ]);
  });

  it("does not throw when the transport fails", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    await expect(
      archiveCommentNotifications(db, question.id, failing)
    ).resolves.toBeUndefined();
  });

  it("cancels a deleted Question's New question for the owning Instructor, in case its batch is still open", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, cancelled } = recordingTransport();

    await archiveCommentNotifications(db, question.id, transport);

    expect(cancelled).toEqual([
      {
        workflow: "new-question",
        cancellationKey: `comment-${question.id}`,
        recipients: [`cadence-${instructor.id}`],
      },
    ]);
  });

  it("still archives when the cancel fails", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, archived } = recordingTransport();
    transport.cancel = failing.cancel;

    await archiveCommentNotifications(db, question.id, transport);

    expect(archived).toEqual([
      { comment_id: question.id, lesson_id: lessonId },
    ]);
  });

  describe("archiving a delivered New question", () => {
    function softDelete(commentId: number) {
      db.update(schema.comments)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(schema.comments.id, commentId))
        .run();
    }

    /** A delivered New question batch holding `ids`, newest last. */
    function batchOf(id: string, ids: number[], archived_at?: string) {
      const activities = ids.map((comment_id) => ({
        data: { comment_id, lesson_id: lessonId },
      }));
      return {
        id,
        source: "new-question",
        data: activities.at(-1)!.data,
        activities,
        archived_at,
      };
    }

    it("leaves it in the Feed while any Question in it is live", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      const q2 = postComment(db, student.id, lessonId, null, "Two?");
      softDelete(q2.id);
      const { knock, archivedBatches } = fakeKnockMessages([
        batchOf("batch", [q1.id, q2.id]),
      ]);

      await archiveCommentNotifications(db, q2.id, knockTransport(knock));

      expect(archivedBatches.flat()).toEqual([]);
    });

    it("archives it once every Question in it is deleted", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      const q2 = postComment(db, otherStudent.id, lessonId, null, "Two?");
      softDelete(q1.id);
      softDelete(q2.id);
      const { knock, archivedBatches } = fakeKnockMessages([
        batchOf("batch", [q1.id, q2.id]),
      ]);

      await archiveCommentNotifications(db, q2.id, knockTransport(knock));

      expect(archivedBatches.flat()).toEqual(["batch"]);
    });

    it("archives a lone New question when its Question is deleted", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      softDelete(q1.id);
      const { knock, archivedBatches } = fakeKnockMessages([
        batchOf("lone", [q1.id]),
      ]);

      await archiveCommentNotifications(db, q1.id, knockTransport(knock));

      expect(archivedBatches.flat()).toEqual(["lone"]);
    });

    it("skips a New question that is already archived", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      softDelete(q1.id);
      const { knock, archivedBatches } = fakeKnockMessages([
        batchOf("old", [q1.id], "2026-11-23T10:00:00Z"),
      ]);

      await archiveCommentNotifications(db, q1.id, knockTransport(knock));

      expect(archivedBatches.flat()).toEqual([]);
    });
  });

  it("cancels nothing when a Reply is deleted", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(db, instructor.id, lessonId, question.id, "Hi");
    const { transport, cancelled } = recordingTransport();

    await archiveCommentNotifications(db, reply.id, transport);

    expect(cancelled).toEqual([]);
  });
});

describe("notifyRefundRequestRaised", () => {
  function addAdmin(name: string) {
    return db
      .insert(schema.users)
      .values({
        name,
        email: `${name.toLowerCase()}@example.com`,
        role: UserRole.Admin,
      })
      .returning()
      .get();
  }

  function raise(buyerId: number, amountPaid = 7900) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: buyerId, courseId, amountPaid })
      .returning()
      .get();
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      buyerId,
      "It wasn't what I expected.",
      new Date()
    );
    if (!raised.ok) throw new Error(raised.error);
    return raised.refundRequestId;
  }

  function sent(triggers: Recorded[], workflow: string) {
    return triggers.filter((t) => t.workflowKey === workflow);
  }

  it("sends Refund Request raised to every Platform Admin", async () => {
    const ada = addAdmin("Ada");
    const ben = addAdmin("Ben");
    const id = raise(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    const raised = sent(triggers, "refund-request-raised");
    expect(raised).toHaveLength(1);
    expect(raised[0].recipients).toEqual([
      { id: `cadence-${ada.id}`, name: "Ada", email: "ada@example.com" },
      { id: `cadence-${ben.id}`, name: "Ben", email: "ben@example.com" },
    ]);
  });

  it("leaves out a Platform Admin who raised the Refund Request themselves", async () => {
    const ada = addAdmin("Ada");
    const ben = addAdmin("Ben");
    const id = raise(ben.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    expect(
      sent(triggers, "refund-request-raised").map((t) =>
        t.recipients.map((r) => r.id)
      )
    ).toEqual([[`cadence-${ada.id}`]]);
  });

  it("sends no Refund Request raised when no other Platform Admin exists", async () => {
    const ada = addAdmin("Ada");
    const id = raise(ada.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    expect(sent(triggers, "refund-request-raised")).toEqual([]);
  });

  it("carries the Student, course, amount and a stable link to the Refund Request", async () => {
    addAdmin("Ada");
    const id = raise(student.id, 7900);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    const [raised] = sent(triggers, "refund-request-raised");
    expect(raised.actor).toEqual({
      id: `cadence-${student.id}`,
      name: "Liam",
      email: "liam@example.com",
    });
    expect(raised.data).toEqual({
      refund_request_id: id,
      actor_name: "Liam",
      course_title: "Introduction to TypeScript",
      amount: "$79.00",
      url: `/admin/refund-requests?request=${id}`,
    });
  });

  it("sends Refund Request received to the person who raised it", async () => {
    addAdmin("Ada");
    const id = raise(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    const received = sent(triggers, "refund-request-received");
    expect(received).toHaveLength(1);
    expect(received[0].recipients).toEqual([
      { id: `cadence-${student.id}`, name: "Liam", email: "liam@example.com" },
    ]);
    expect(received[0].data).toEqual({
      refund_request_id: id,
      course_title: "Introduction to TypeScript",
      url: "/courses/intro-ts",
    });
  });

  it("sends Refund Request received to a Platform Admin who raised one", async () => {
    const ada = addAdmin("Ada");
    const id = raise(ada.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestRaised(db, id, transport);

    expect(
      sent(triggers, "refund-request-received").map((t) =>
        t.recipients.map((r) => r.id)
      )
    ).toEqual([[`cadence-${ada.id}`]]);
  });

  it("still sends Refund Request received when Refund Request raised fails", async () => {
    addAdmin("Ada");
    const id = raise(student.id);
    const { transport, triggers } = recordingTransport();
    const flaky: NotificationTransport = {
      ...transport,
      async trigger(workflow, trigger) {
        if (workflow === "refund-request-raised")
          throw new Error("Knock is down");
        await transport.trigger(workflow, trigger);
      },
    };

    await notifyRefundRequestRaised(db, id, flaky);

    expect(triggers.map((t) => t.workflowKey)).toEqual([
      "refund-request-received",
    ]);
  });

  it("does not throw when the transport fails", async () => {
    addAdmin("Ada");
    const id = raise(student.id);
    await expect(
      notifyRefundRequestRaised(db, id, failing)
    ).resolves.toBeUndefined();
  });
});

describe("notifyRefundRequestDecided", () => {
  function raise(buyerId: number, amountPaid = 7900) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: buyerId, courseId, amountPaid })
      .returning()
      .get();
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      buyerId,
      "It wasn't what I expected.",
      new Date()
    );
    if (!raised.ok) throw new Error(raised.error);
    return { refundRequestId: raised.refundRequestId, purchaseId: purchase.id };
  }

  /** Records a decision the way the admin queue's transaction does. */
  function decide(
    refundRequestId: number,
    status: RefundRequestStatus.Approved | RefundRequestStatus.Declined
  ) {
    db.update(schema.refundRequests)
      .set({ status, decidedAt: new Date().toISOString() })
      .where(eq(schema.refundRequests.id, refundRequestId))
      .run();
  }

  it("sends Refund Request approved to the person who raised it", async () => {
    const { refundRequestId } = raise(student.id, 7900);
    decide(refundRequestId, RefundRequestStatus.Approved);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestDecided(db, refundRequestId, transport);

    expect(triggers).toEqual([
      {
        workflowKey: "refund-request-approved",
        recipients: [
          {
            id: `cadence-${student.id}`,
            name: "Liam",
            email: "liam@example.com",
          },
        ],
        data: {
          refund_request_id: refundRequestId,
          course_title: "Introduction to TypeScript",
          amount: "$79.00",
          url: "/courses/intro-ts",
        },
      },
    ]);
  });

  it("sends Refund Request declined to the person who raised it", async () => {
    const { refundRequestId } = raise(student.id);
    decide(refundRequestId, RefundRequestStatus.Declined);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestDecided(db, refundRequestId, transport);

    expect(triggers).toEqual([
      {
        workflowKey: "refund-request-declined",
        recipients: [
          {
            id: `cadence-${student.id}`,
            name: "Liam",
            email: "liam@example.com",
          },
        ],
        data: {
          refund_request_id: refundRequestId,
          course_title: "Introduction to TypeScript",
          url: "/courses/intro-ts",
        },
      },
    ]);
  });

  it("sends a Team Licence's decision to its Team Admin, not its Seat holders", async () => {
    const teamAdmin = db
      .insert(schema.users)
      .values({
        name: "Tara",
        email: "tara@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: teamAdmin.id,
        role: TeamMemberRole.Admin,
      })
      .run();
    const { refundRequestId, purchaseId } = raise(teamAdmin.id, 7900 * 3);
    db.insert(schema.coupons)
      .values([
        { teamId: team.id, courseId, code: "SEAT-1", purchaseId },
        { teamId: team.id, courseId, code: "SEAT-2", purchaseId },
      ])
      .run();
    decide(refundRequestId, RefundRequestStatus.Approved);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestDecided(db, refundRequestId, transport);

    expect(triggers.map((t) => [t.workflowKey, t.recipients])).toEqual([
      [
        "refund-request-approved",
        [
          {
            id: `cadence-${teamAdmin.id}`,
            name: "Tara",
            email: "tara@example.com",
          },
        ],
      ],
    ]);
    expect(triggers[0].data).toMatchObject({ amount: "$237.00" });
  });

  it("sends nothing for a Refund Request that is still Open", async () => {
    // A refused decision (the Platform Admin's own request, or a Team Licence
    // with a Claimed Seat) leaves the Refund Request Open.
    const { refundRequestId } = raise(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyRefundRequestDecided(db, refundRequestId, transport);

    expect(triggers).toEqual([]);
  });

  it("does not throw when the transport fails", async () => {
    const { refundRequestId } = raise(student.id);
    decide(refundRequestId, RefundRequestStatus.Approved);

    await expect(
      notifyRefundRequestDecided(db, refundRequestId, failing)
    ).resolves.toBeUndefined();
  });
});

describe("decideRefundRequest: Refund Request approved and declined", () => {
  let admin: typeof schema.users.$inferSelect;

  beforeEach(() => {
    admin = db
      .insert(schema.users)
      .values({ name: "Ada", email: "ada@example.com", role: UserRole.Admin })
      .returning()
      .get();
  });

  function raise(buyerId: number) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: buyerId, courseId, amountPaid: 7900 })
      .returning()
      .get();
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      buyerId,
      "It wasn't what I expected.",
      new Date()
    );
    if (!raised.ok) throw new Error(raised.error);
    return { refundRequestId: raised.refundRequestId, purchaseId: purchase.id };
  }

  it("sends Refund Request approved once the decision commits", async () => {
    const { refundRequestId } = raise(student.id);
    const { transport, triggers } = recordingTransport();

    const decided = await decideRefundRequest(
      db,
      refundRequestId,
      admin.id,
      RefundRequestStatus.Approved,
      transport
    );

    expect(decided.ok).toBe(true);
    expect(triggers.map((t) => t.workflowKey)).toEqual([
      "refund-request-approved",
    ]);
  });

  it("sends nothing when the Refund Request is already decided", async () => {
    const { refundRequestId } = raise(student.id);
    await decideRefundRequest(
      db,
      refundRequestId,
      admin.id,
      RefundRequestStatus.Declined,
      recordingTransport().transport
    );
    const { transport, triggers } = recordingTransport();

    const decided = await decideRefundRequest(
      db,
      refundRequestId,
      admin.id,
      RefundRequestStatus.Approved,
      transport
    );

    expect(decided).toEqual({
      ok: false,
      status: 409,
      error: "This refund request has already been decided.",
    });
    expect(triggers).toEqual([]);
  });

  it("sends nothing when a Platform Admin decides their own Refund Request", async () => {
    const { refundRequestId } = raise(admin.id);
    const { transport, triggers } = recordingTransport();

    const decided = await decideRefundRequest(
      db,
      refundRequestId,
      admin.id,
      RefundRequestStatus.Declined,
      transport
    );

    expect(decided).toEqual({
      ok: false,
      status: 409,
      error:
        "You cannot decide your own refund request. Another Platform Admin must decide it.",
    });
    expect(triggers).toEqual([]);
  });

  it("sends nothing when approving a Team Licence with a Claimed Seat", async () => {
    const team = db.insert(schema.teams).values({}).returning().get();
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: student.id, courseId, amountPaid: 7900 * 2 })
      .returning()
      .get();
    db.insert(schema.coupons)
      .values([
        { teamId: team.id, courseId, code: "SEAT-1", purchaseId: purchase.id },
        { teamId: team.id, courseId, code: "SEAT-2", purchaseId: purchase.id },
      ])
      .run();
    // Raised while every Seat was Unclaimed; one is Claimed while it is Open.
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      student.id,
      "We no longer need it.",
      new Date()
    );
    if (!raised.ok) throw new Error(raised.error);
    db.update(schema.coupons)
      .set({
        redeemedByUserId: otherStudent.id,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(schema.coupons.code, "SEAT-1"))
      .run();
    const { transport, triggers } = recordingTransport();

    const decided = await decideRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      RefundRequestStatus.Approved,
      transport
    );

    expect(decided).toEqual({
      ok: false,
      status: 409,
      error:
        "1 Seat has been claimed on this Team Licence, so it cannot be refunded.",
    });
    expect(triggers).toEqual([]);
  });
});

describe("Refund issued and Refund failed", () => {
  let admin: typeof schema.users.$inferSelect;

  beforeEach(() => {
    admin = db
      .insert(schema.users)
      .values({ name: "Ada", email: "ada@example.com", role: UserRole.Admin })
      .returning()
      .get();
  });

  /** An approved Refund Request on a Purchase by `buyerId`, and its Refund. */
  async function refundFor(buyerId: number, amountPaid = 7900) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: buyerId, courseId, amountPaid })
      .returning()
      .get();
    const raised = raiseRefundRequest(
      db,
      purchase.id,
      buyerId,
      "It wasn't what I expected.",
      new Date()
    );
    if (!raised.ok) throw new Error(raised.error);
    const decided = await decideRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      RefundRequestStatus.Approved,
      recordingTransport().transport
    );
    if (!decided.ok) throw new Error(decided.error);
    const refund = db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.refundRequestId, raised.refundRequestId))
      .get();
    if (!refund) throw new Error("No Refund was created");
    return { refundId: refund.id, refundRequestId: raised.refundRequestId };
  }

  /** A Student who is a Team's Team Admin, and so buys its Team Licences. */
  function addTeamAdmin() {
    const teamAdmin = db
      .insert(schema.users)
      .values({
        name: "Tara",
        email: "tara@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: teamAdmin.id,
        role: TeamMemberRole.Admin,
      })
      .run();
    return teamAdmin;
  }

  /** Moves a Refund on, as whatever settles it with the payment provider. */
  function settle(
    refundId: number,
    status: RefundStatus.Issued | RefundStatus.Failed
  ) {
    db.update(schema.refunds)
      .set({ status, settledAt: new Date().toISOString() })
      .where(eq(schema.refunds.id, refundId))
      .run();
  }

  describe("notifyRefundIssued", () => {
    it("sends Refund issued to the Student, with the amount and the course", async () => {
      const { refundId } = await refundFor(student.id, 7900);
      settle(refundId, RefundStatus.Issued);
      const { transport, triggers } = recordingTransport();

      await notifyRefundIssued(db, refundId, transport);

      expect(triggers).toEqual([
        {
          workflowKey: "refund-issued",
          recipients: [
            {
              id: `cadence-${student.id}`,
              name: "Liam",
              email: "liam@example.com",
            },
          ],
          data: {
            refund_id: refundId,
            course_title: "Introduction to TypeScript",
            amount: "$79.00",
            url: "/courses/intro-ts",
          },
        },
      ]);
    });

    it("sends a Team Licence's Refund issued to its Team Admin", async () => {
      const teamAdmin = addTeamAdmin();
      const { refundId } = await refundFor(teamAdmin.id, 7900 * 3);
      settle(refundId, RefundStatus.Issued);
      const { transport, triggers } = recordingTransport();

      await notifyRefundIssued(db, refundId, transport);

      expect(triggers.map((t) => t.recipients.map((r) => r.id))).toEqual([
        [`cadence-${teamAdmin.id}`],
      ]);
      expect(triggers[0].data).toMatchObject({ amount: "$237.00" });
    });

    it("sends nothing for a Refund that isn't Issued", async () => {
      const pending = await refundFor(student.id);
      const failed = await refundFor(otherStudent.id);
      settle(failed.refundId, RefundStatus.Failed);
      const { transport, triggers } = recordingTransport();

      await notifyRefundIssued(db, pending.refundId, transport);
      await notifyRefundIssued(db, failed.refundId, transport);

      expect(triggers).toEqual([]);
    });

    it("does not throw when the transport fails", async () => {
      const { refundId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Issued);

      await expect(
        notifyRefundIssued(db, refundId, failing)
      ).resolves.toBeUndefined();
    });
  });

  describe("notifyRefundFailed", () => {
    function addAdmin(name: string) {
      return db
        .insert(schema.users)
        .values({
          name,
          email: `${name.toLowerCase()}@example.com`,
          role: UserRole.Admin,
        })
        .returning()
        .get();
    }

    function sent(triggers: Recorded[], workflow: string) {
      return triggers.filter((t) => t.workflowKey === workflow);
    }

    it("tells the Student Cadence is on it, linking to the course", async () => {
      const { refundId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Failed);
      const { transport, triggers } = recordingTransport();

      await notifyRefundFailed(db, refundId, transport);

      expect(sent(triggers, "refund-failed")).toEqual([
        {
          workflowKey: "refund-failed",
          recipients: [
            {
              id: `cadence-${student.id}`,
              name: "Liam",
              email: "liam@example.com",
            },
          ],
          data: {
            refund_id: refundId,
            course_title: "Introduction to TypeScript",
            url: "/courses/intro-ts",
          },
        },
      ]);
    });

    it("tells every Platform Admin, linking to the Refund Request on the queue", async () => {
      const ben = addAdmin("Ben");
      const { refundId, refundRequestId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Failed);
      const { transport, triggers } = recordingTransport();

      await notifyRefundFailed(db, refundId, transport);

      expect(sent(triggers, "refund-failed-admin")).toEqual([
        {
          workflowKey: "refund-failed-admin",
          recipients: [
            {
              id: `cadence-${admin.id}`,
              name: "Ada",
              email: "ada@example.com",
            },
            { id: `cadence-${ben.id}`, name: "Ben", email: "ben@example.com" },
          ],
          data: {
            refund_id: refundId,
            refund_request_id: refundRequestId,
            student_name: "Liam",
            course_title: "Introduction to TypeScript",
            url: `/admin/refund-requests?request=${refundRequestId}`,
          },
        },
      ]);
    });

    it("sends a Team Licence's Student copy to its Team Admin", async () => {
      const teamAdmin = addTeamAdmin();
      const { refundId } = await refundFor(teamAdmin.id, 7900 * 3);
      settle(refundId, RefundStatus.Failed);
      const { transport, triggers } = recordingTransport();

      await notifyRefundFailed(db, refundId, transport);

      expect(
        sent(triggers, "refund-failed").map((t) =>
          t.recipients.map((r) => r.id)
        )
      ).toEqual([[`cadence-${teamAdmin.id}`]]);
      expect(sent(triggers, "refund-failed-admin")[0].data).toMatchObject({
        student_name: "Tara",
      });
    });

    it("still tells the Platform Admins when the Student's copy fails", async () => {
      const { refundId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Failed);
      const { transport, triggers } = recordingTransport();
      const flaky: NotificationTransport = {
        ...transport,
        async trigger(workflow, trigger) {
          if (workflow === "refund-failed") throw new Error("Knock is down");
          await transport.trigger(workflow, trigger);
        },
      };

      await notifyRefundFailed(db, refundId, flaky);

      expect(triggers.map((t) => t.workflowKey)).toEqual([
        "refund-failed-admin",
      ]);
    });

    it("still tells the Student, and no Platform Admin, when there are none", async () => {
      const { refundId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Failed);
      db.update(schema.users)
        .set({ role: UserRole.Student })
        .where(eq(schema.users.id, admin.id))
        .run();
      const { transport, triggers } = recordingTransport();

      await notifyRefundFailed(db, refundId, transport);

      expect(
        triggers.map((t) => [t.workflowKey, t.recipients.map((r) => r.id)])
      ).toEqual([["refund-failed", [`cadence-${student.id}`]]]);
    });

    it("sends nothing for a Refund that isn't Failed", async () => {
      const pending = await refundFor(student.id);
      const issued = await refundFor(otherStudent.id);
      settle(issued.refundId, RefundStatus.Issued);
      const { transport, triggers } = recordingTransport();

      await notifyRefundFailed(db, pending.refundId, transport);
      await notifyRefundFailed(db, issued.refundId, transport);

      expect(triggers).toEqual([]);
    });

    it("does not throw when the transport fails", async () => {
      const { refundId } = await refundFor(student.id);
      settle(refundId, RefundStatus.Failed);

      await expect(
        notifyRefundFailed(db, refundId, failing)
      ).resolves.toBeUndefined();
    });
  });
});

describe("notifyNewPurchase", () => {
  function buy(buyerId: number) {
    return db
      .insert(schema.purchases)
      .values({ userId: buyerId, courseId, amountPaid: 7900 })
      .returning()
      .get();
  }

  it("sends New Purchase for an Individual Purchase to the course's owning Instructor", async () => {
    const purchase = buy(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyNewPurchase(db, purchase.id, transport);

    expect(triggers).toHaveLength(1);
    expect(triggers[0].workflowKey).toBe("new-purchase");
    expect(triggers[0].recipients).toEqual([
      {
        id: `cadence-${instructor.id}`,
        name: "Sarah",
        email: "sarah@example.com",
      },
    ]);
  });

  it("carries the buyer, the course as its batch key, and a link to the buyer on the roster", async () => {
    const purchase = buy(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyNewPurchase(db, purchase.id, transport);

    expect(triggers[0].actor).toEqual({
      id: `cadence-${student.id}`,
      name: "Liam",
      email: "liam@example.com",
    });
    expect(triggers[0].data).toEqual({
      purchase_id: purchase.id,
      course_id: courseId,
      actor_name: "Liam",
      course_title: "Introduction to TypeScript",
      seat_count: null,
      url: `/instructor/${courseId}/students#student-${student.id}`,
    });
  });

  it("sends New Purchase for a Team Licence with its seat count", async () => {
    const team = db.insert(schema.teams).values({}).returning().get();
    const purchase = buy(student.id);
    for (const code of ["A", "B", "C"]) {
      db.insert(schema.coupons)
        .values({ teamId: team.id, courseId, code, purchaseId: purchase.id })
        .run();
    }
    const { transport, triggers } = recordingTransport();

    await notifyNewPurchase(db, purchase.id, transport);

    expect(triggers.map((t) => t.recipients.map((r) => r.id))).toEqual([
      [`cadence-${instructor.id}`],
    ]);
    expect(triggers[0].data).toMatchObject({
      course_id: courseId,
      seat_count: 3,
    });
  });

  it("sends nothing when the course's Instructor bought it themselves", async () => {
    const purchase = buy(instructor.id);
    const { transport, triggers } = recordingTransport();

    await notifyNewPurchase(db, purchase.id, transport);

    expect(triggers).toEqual([]);
  });

  it("never sends New Purchase to a Platform Admin who owns the course", async () => {
    db.update(schema.users)
      .set({ role: UserRole.Admin })
      .where(eq(schema.users.id, instructor.id))
      .run();
    const purchase = buy(student.id);
    const { transport, triggers } = recordingTransport();

    await notifyNewPurchase(db, purchase.id, transport);

    expect(triggers).toEqual([]);
  });

  it("does not throw when the transport fails", async () => {
    const purchase = buy(student.id);

    await expect(
      notifyNewPurchase(db, purchase.id, failing)
    ).resolves.toBeUndefined();
  });
});

describe("outboxTransport", () => {
  const commentReplyData = {
    comment_id: 42,
    actor_name: "Sarah",
    lesson_title: "Generics",
    url: "/courses/intro-ts/lessons/3#comment-42",
  };

  it("writes the trigger to the outbox when there is no Knock key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await outboxTransport(directory).trigger("comment-reply", {
      recipients: [
        { id: "cadence-1", name: "Liam", email: "liam@example.com" },
      ],
      data: commentReplyData,
    });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toMatchObject({
      workflowKey: "comment-reply",
      recipients: [
        { id: "cadence-1", name: "Liam", email: "liam@example.com" },
      ],
      data: commentReplyData,
    });
  });

  it("records an archive request in the outbox when there is no Knock key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await outboxTransport(directory).archiveMessages(
      { comment_id: 42, lesson_id: 3 },
      () => true
    );

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-notification-archive\.json$/);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toEqual({ archive: { comment_id: 42, lesson_id: 3 } });
  });

  it("records a cancel request in the outbox when there is no Knock key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await outboxTransport(directory).cancel({
      workflow: "new-question",
      cancellationKey: "comment-42",
      recipients: ["cadence-1"],
    });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-notification-cancel\.json$/);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toEqual({
      cancel: {
        workflow: "new-question",
        cancellationKey: "comment-42",
        recipients: ["cadence-1"],
      },
    });
  });
});

/** Knock's workflows API, recording what the transport asks of it. */
function fakeKnockWorkflows() {
  const triggered: { key: string; body: Record<string, unknown> }[] = [];
  const cancelled: { key: string; body: Record<string, unknown> }[] = [];
  const workflows: KnockClient["workflows"] = {
    trigger: (async (key: string, body: Record<string, unknown>) => {
      triggered.push({ key, body });
      return { workflow_run_id: "run-1" };
    }) as unknown as KnockClient["workflows"]["trigger"],
    cancel: (async (key: string, body: Record<string, unknown>) => {
      cancelled.push({ key, body });
    }) as unknown as KnockClient["workflows"]["cancel"],
  };
  return { workflows, triggered, cancelled };
}

const noMessages: KnockMessagesApi = {
  async *list() {},
  async *listActivities() {},
  batch: { async archive() {} },
};

describe("knockTransport trigger and cancel", () => {
  const person = { id: "cadence-1", name: "Sarah", email: "sarah@example.com" };
  const newQuestionData = {
    comment_id: 9,
    lesson_id: 3,
    actor_name: "Liam",
    lesson_title: "Generics",
    url: "/courses/intro-ts/lessons/3#comment-9",
  };

  it("triggers with the cancellation key", async () => {
    const { workflows, triggered } = fakeKnockWorkflows();

    await knockTransport({ workflows, messages: noMessages }).trigger(
      "new-question",
      {
        recipients: [person],
        data: newQuestionData,
        cancellationKey: "comment-9",
      }
    );

    expect(triggered).toEqual([
      {
        key: "new-question",
        body: {
          recipients: [person],
          actor: undefined,
          data: newQuestionData,
          cancellation_key: "comment-9",
        },
      },
    ]);
  });

  it("cancels by key for the given recipients", async () => {
    const { workflows, cancelled } = fakeKnockWorkflows();

    await knockTransport({ workflows, messages: noMessages }).cancel({
      workflow: "new-question",
      cancellationKey: "comment-9",
      recipients: ["cadence-1"],
    });

    expect(cancelled).toEqual([
      {
        key: "new-question",
        body: { cancellation_key: "comment-9", recipients: ["cadence-1"] },
      },
    ]);
  });
});

describe("knockTransport archiveMessages", () => {
  const batched = (id: string, ids: number[], lesson_id = 7) => {
    const activities = ids.map((comment_id) => ({
      data: { comment_id, lesson_id },
    }));
    return {
      id,
      source: "new-question",
      data: activities.at(-1)!.data,
      activities,
    };
  };
  const deleted =
    (...ids: number[]) =>
    (commentId: number) =>
      ids.includes(commentId);

  it("archives a New question on the lesson once every Question in it is deleted", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      batched("batched", [1, 2]),
      batched("other-lesson", [3], 8),
    ]);

    await knockTransport(knock).archiveMessages(
      { comment_id: 1, lesson_id: 7 },
      deleted(1, 2, 3)
    );

    expect(archivedBatches.flat()).toEqual(["batched"]);
  });

  it("leaves a New question alone while any Question in it is live", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      batched("batched", [1, 2]),
    ]);

    await knockTransport(knock).archiveMessages(
      { comment_id: 2, lesson_id: 7 },
      deleted(2)
    );

    expect(archivedBatches.flat()).toEqual([]);
  });

  it("leaves a New question alone that doesn't hold the deleted Comment", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      batched("batched", [1, 2]),
    ]);

    await knockTransport(knock).archiveMessages(
      { comment_id: 5, lesson_id: 7 },
      deleted(1, 2, 5)
    );

    expect(archivedBatches.flat()).toEqual([]);
  });

  it("skips messages that are already archived", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      { ...batched("old", [1]), archived_at: "2026-11-23T10:00:00Z" },
      {
        id: "old-reply",
        source: "comment-reply",
        data: { comment_id: 1 },
        activities: [{ data: { comment_id: 1 } }],
        archived_at: "2026-11-23T10:00:00Z",
      },
    ]);

    await knockTransport(knock).archiveMessages(
      { comment_id: 1, lesson_id: 7 },
      deleted(1)
    );

    expect(archivedBatches.flat()).toEqual([]);
  });

  it("archives every recipient's Comment reply about the deleted Comment", async () => {
    const reply = (id: string) => ({
      id,
      source: "comment-reply",
      data: { comment_id: 9 },
      activities: [{ data: { comment_id: 9 } }],
    });
    const { knock, archivedBatches } = fakeKnockMessages([
      reply("for-liam"),
      reply("for-maya"),
    ]);

    await knockTransport(knock).archiveMessages(
      { comment_id: 9, lesson_id: 7 },
      deleted(9)
    );

    expect(archivedBatches.flat().sort()).toEqual(["for-liam", "for-maya"]);
  });
});
