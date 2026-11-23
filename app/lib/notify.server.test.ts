import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { CourseStatus, UserRole } from "~/db/schema";
import type { Db } from "~/db";
import { createTestDb } from "~/test/setup";
import { postComment } from "./comments.server";
import type { NotificationWorkflow } from "./notifications";
import {
  archiveCommentNotifications,
  knockTransport,
  notifyCommentPosted,
  outboxTransport,
  type ArchivedNewQuestion,
  type DeletedComment,
  type KnockClient,
  type KnockMessagesApi,
  type NotificationCancel,
  type NotificationTransport,
  type NotificationTrigger,
} from "./notify.server";

type Recorded = { workflowKey: NotificationWorkflow } & NotificationTrigger;

/**
 * Records what it is asked to do. `archivedNewQuestions` is what Knock would
 * report archiving: the New question messages that held the deleted Comment.
 */
function recordingTransport(archivedNewQuestions: ArchivedNewQuestion[] = []) {
  const triggers: Recorded[] = [];
  const archived: DeletedComment[] = [];
  const cancelled: NotificationCancel[] = [];
  const resent: NotificationTrigger<"new-question">[] = [];
  const transport: NotificationTransport = {
    async trigger(workflowKey, trigger) {
      triggers.push({ workflowKey, ...trigger });
    },
    async cancel(request) {
      cancelled.push(request);
    },
    async archiveMessages(filter) {
      archived.push(filter);
      return archivedNewQuestions;
    },
    async resendNewQuestion(trigger) {
      resent.push(trigger);
    },
  };
  return { transport, triggers, archived, cancelled, resent };
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
  async resendNewQuestion() {
    throw new Error("Knock is down");
  },
};

let db: Db;
let student: typeof schema.users.$inferSelect;
let otherStudent: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let lessonId: number;

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

  describe("re-sending a delivered New question", () => {
    function softDelete(commentId: number) {
      db.update(schema.comments)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(schema.comments.id, commentId))
        .run();
    }

    it("re-sends one New question for the Questions still live, linked to the latest", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      const q2 = postComment(db, student.id, lessonId, null, "Two?");
      const q3 = postComment(db, otherStudent.id, lessonId, null, "Three?");
      softDelete(q1.id);
      const { transport, resent } = recordingTransport([
        {
          recipient: `cadence-${instructor.id}`,
          comment_ids: [q1.id, q2.id, q3.id],
        },
      ]);

      await archiveCommentNotifications(db, q1.id, transport);

      expect(resent).toEqual([
        {
          recipients: [
            {
              id: `cadence-${instructor.id}`,
              name: "Sarah",
              email: "sarah@example.com",
            },
          ],
          actor: {
            id: `cadence-${otherStudent.id}`,
            name: "Maya",
            email: "maya@example.com",
          },
          data: {
            comment_id: q3.id,
            comment_ids: [q2.id, q3.id],
            lesson_id: lessonId,
            actor_name: "Maya",
            lesson_title: "Generics",
            url: `/courses/intro-ts/lessons/${lessonId}#comment-${q3.id}`,
          },
        },
      ]);
    });

    it("leaves out every Question deleted since the batch was sent", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      const q2 = postComment(db, otherStudent.id, lessonId, null, "Two?");
      const q3 = postComment(db, student.id, lessonId, null, "Three?");
      softDelete(q3.id);
      softDelete(q1.id);
      const { transport, resent } = recordingTransport([
        {
          recipient: `cadence-${instructor.id}`,
          comment_ids: [q1.id, q2.id, q3.id],
        },
      ]);

      await archiveCommentNotifications(db, q1.id, transport);

      expect(resent.map((t) => t.data)).toEqual([
        {
          comment_id: q2.id,
          comment_ids: [q2.id],
          lesson_id: lessonId,
          actor_name: "Maya",
          lesson_title: "Generics",
          url: `/courses/intro-ts/lessons/${lessonId}#comment-${q2.id}`,
        },
      ]);
    });

    it("re-sends nothing when no Question in it is still live", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      softDelete(q1.id);
      const { transport, resent } = recordingTransport([
        { recipient: `cadence-${instructor.id}`, comment_ids: [q1.id] },
      ]);

      await archiveCommentNotifications(db, q1.id, transport);

      expect(resent).toEqual([]);
    });

    it("does not throw when the re-send fails", async () => {
      const q1 = postComment(db, student.id, lessonId, null, "One?");
      const q2 = postComment(db, student.id, lessonId, null, "Two?");
      softDelete(q1.id);
      const { transport } = recordingTransport([
        {
          recipient: `cadence-${instructor.id}`,
          comment_ids: [q1.id, q2.id],
        },
      ]);
      transport.resendNewQuestion = failing.resendNewQuestion;

      await expect(
        archiveCommentNotifications(db, q1.id, transport)
      ).resolves.toBeUndefined();
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

    await outboxTransport(directory).archiveMessages({
      comment_id: 42,
      lesson_id: 3,
    });

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

  it("records a re-send in the outbox when there is no Knock key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));
    const resend = {
      recipients: [
        { id: "cadence-1", name: "Sarah", email: "sarah@example.com" },
      ],
      data: {
        comment_id: 9,
        comment_ids: [8, 9],
        lesson_id: 3,
        actor_name: "Liam",
        lesson_title: "Generics",
        url: "/courses/intro-ts/lessons/3#comment-9",
      },
    };

    await outboxTransport(directory).resendNewQuestion(resend);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-notification-new-question-resend\.json$/);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toEqual({ workflowKey: "new-question", resend });
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

  it("re-sends New question flagged to skip the batch step", async () => {
    const { workflows, triggered } = fakeKnockWorkflows();
    const data = { ...newQuestionData, comment_ids: [8, 9] };

    await knockTransport({ workflows, messages: noMessages }).resendNewQuestion(
      { recipients: [person], data }
    );

    expect(triggered).toEqual([
      {
        key: "new-question",
        body: {
          recipients: [person],
          actor: undefined,
          data: { ...data, skip_batch: true },
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
  type StoredMessage = {
    id: string;
    source: string;
    /** Knock's merged data: for a batch, the newest trigger's values win. */
    data: Record<string, unknown>;
    activities: { data: Record<string, unknown> }[];
    recipient?: string;
  };

  /** Knock's messages API, as far as the archive uses it, over a fixed store. */
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
              source: { key: message.source },
              recipient: message.recipient ?? "cadence-1",
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
      workflows: {} as KnockClient["workflows"],
      messages,
    };
    return { knock, archivedBatches };
  }

  it("archives a batched New question when an earlier Question in it is deleted", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      {
        id: "batched",
        source: "new-question",
        data: { comment_id: 2, lesson_id: 7 },
        activities: [
          { data: { comment_id: 1, lesson_id: 7 } },
          { data: { comment_id: 2, lesson_id: 7 } },
        ],
      },
      {
        id: "other-lesson",
        source: "new-question",
        data: { comment_id: 3, lesson_id: 8 },
        activities: [{ data: { comment_id: 3, lesson_id: 8 } }],
      },
    ]);

    await knockTransport(knock).archiveMessages({
      comment_id: 1,
      lesson_id: 7,
    });

    expect(archivedBatches.flat()).toEqual(["batched"]);
  });

  it("leaves a batched New question alone when none of its Questions was deleted", async () => {
    const { knock, archivedBatches } = fakeKnockMessages([
      {
        id: "batched",
        source: "new-question",
        data: { comment_id: 2, lesson_id: 7 },
        activities: [
          { data: { comment_id: 1, lesson_id: 7 } },
          { data: { comment_id: 2, lesson_id: 7 } },
        ],
      },
    ]);

    await knockTransport(knock).archiveMessages({
      comment_id: 5,
      lesson_id: 7,
    });

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

    await knockTransport(knock).archiveMessages({
      comment_id: 9,
      lesson_id: 7,
    });

    expect(archivedBatches.flat().sort()).toEqual(["for-liam", "for-maya"]);
  });

  it("reports each archived New question with every Question in it", async () => {
    const { knock } = fakeKnockMessages([
      {
        id: "batched",
        source: "new-question",
        data: { comment_id: 2, lesson_id: 7 },
        activities: [
          { data: { comment_id: 1, lesson_id: 7 } },
          { data: { comment_id: 2, lesson_id: 7 } },
        ],
      },
    ]);

    const archived = await knockTransport(knock).archiveMessages({
      comment_id: 1,
      lesson_id: 7,
    });

    expect(archived).toEqual([{ recipient: "cadence-1", comment_ids: [1, 2] }]);
  });

  it("finds a re-sent New question by any Question it carries", async () => {
    const resentData = { comment_id: 5, lesson_id: 7, comment_ids: [3, 5] };
    const { knock, archivedBatches } = fakeKnockMessages([
      {
        id: "resent",
        source: "new-question",
        data: resentData,
        activities: [{ data: resentData }],
      },
    ]);

    const archived = await knockTransport(knock).archiveMessages({
      comment_id: 3,
      lesson_id: 7,
    });

    expect(archivedBatches.flat()).toEqual(["resent"]);
    expect(archived).toEqual([{ recipient: "cadence-1", comment_ids: [3, 5] }]);
  });

  it("reports no New question when only a Comment reply was archived", async () => {
    const { knock } = fakeKnockMessages([
      {
        id: "reply",
        source: "comment-reply",
        data: { comment_id: 9 },
        activities: [{ data: { comment_id: 9 } }],
      },
    ]);

    const archived = await knockTransport(knock).archiveMessages({
      comment_id: 9,
      lesson_id: 7,
    });

    expect(archived).toEqual([]);
  });
});
