import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { CourseStatus, UserRole } from "~/db/schema";
import type { Db } from "~/db";
import { createTestDb } from "~/test/setup";
import { postComment } from "./comments.server";
import type { NotificationWorkflow } from "./notifications";
import {
  archiveCommentNotifications,
  notifyCommentReply,
  notifyNewQuestion,
  outboxTransport,
  type MessageFilter,
  type NotificationTransport,
  type NotificationTrigger,
} from "./notify.server";

type Recorded = { workflowKey: NotificationWorkflow } & NotificationTrigger;

function recordingTransport() {
  const triggers: Recorded[] = [];
  const archived: MessageFilter[] = [];
  const transport: NotificationTransport = {
    async trigger(workflowKey, trigger) {
      triggers.push({ workflowKey, ...trigger });
    },
    async archiveMessages(filter) {
      archived.push(filter);
    },
  };
  return { transport, triggers, archived };
}

const failing: NotificationTransport = {
  async trigger() {
    throw new Error("Knock is down");
  },
  async archiveMessages() {
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

describe("notifyCommentReply", () => {
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

    await notifyCommentReply(db, reply.id, transport);

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

    await notifyCommentReply(db, reply.id, transport);

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

    await notifyCommentReply(db, reply.id, transport);

    expect(triggers).toEqual([]);
  });

  it("sends nothing for a top-level Comment", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyCommentReply(db, question.id, transport);

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

    await notifyCommentReply(db, reply.id, transport);

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
      notifyCommentReply(db, reply.id, failing)
    ).resolves.toBeUndefined();
  });
});

describe("notifyNewQuestion", () => {
  it("sends New question to the course's owning Instructor", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyNewQuestion(db, question.id, transport);

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

    await notifyNewQuestion(db, post.id, transport);

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

    await notifyNewQuestion(db, post.id, transport);

    expect(triggers).toEqual([]);
  });

  it("sends nothing for a Reply", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(
      db,
      otherStudent.id,
      lessonId,
      question.id,
      "Same here."
    );
    const { transport, triggers } = recordingTransport();

    await notifyNewQuestion(db, reply.id, transport);

    expect(triggers).toEqual([]);
  });

  it("carries the Question and its lesson, the batch key, and a link to it", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, triggers } = recordingTransport();

    await notifyNewQuestion(db, question.id, transport);

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
});

describe("archiveCommentNotifications", () => {
  it("archives every Notification about the deleted Comment, for every recipient", async () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const { transport, archived } = recordingTransport();

    await archiveCommentNotifications(question.id, transport);

    expect(archived).toEqual([{ comment_id: question.id }]);
  });

  it("does not throw when the transport fails", async () => {
    await expect(
      archiveCommentNotifications(42, failing)
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

    await outboxTransport(directory).archiveMessages({ comment_id: 42 });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-notification-archive\.json$/);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toEqual({ archive: { comment_id: 42 } });
  });
});
