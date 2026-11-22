import { Knock } from "@knocklabs/node";
import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { UserRole, courses, lessons, modules, users } from "~/db/schema";
import { knockConfig, knockUserId } from "~/lib/knock.server";
import { getCommentById } from "~/lib/comments.server";
import { writeToOutbox } from "~/lib/outbox.server";
import { commentHref } from "~/lib/comment-links";
import {
  NotificationWorkflow,
  type NotificationData,
} from "~/lib/notifications";

// ─── Notifications ───
// One function per Notification, called from the action that causes it, after
// the change is written. Each works out its recipients and trigger data from
// the database and hands them to a Notification transport. Knock delivers
// when KNOCK_SECRET_API_KEY is set (ADR 0013). Without it (local dev, tests)
// each trigger, and each archive request, is written to .outbox/ as a JSON
// file instead, as the mailer does.
//
// A Notification never fails the action that caused it: every function here
// catches and logs instead of throwing.

/**
 * A person on a trigger, as a recipient or the actor, identified inline so
 * Knock needs no separate sync.
 */
export type NotificationPerson = {
  id: string;
  name: string;
  email: string;
};

export type NotificationTrigger<
  W extends NotificationWorkflow = NotificationWorkflow,
> = {
  recipients: NotificationPerson[];
  actor?: NotificationPerson;
  data: NotificationData<W>;
};

/** Picks out Knock messages by their trigger data. */
export type MessageFilter = { comment_id: number };

export interface NotificationTransport {
  trigger<W extends NotificationWorkflow>(
    workflow: W,
    trigger: NotificationTrigger<W>
  ): Promise<void>;
  /** Archives every message, for every recipient, matching `filter`. */
  archiveMessages(filter: MessageFilter): Promise<void>;
}

/** Knock archives at most this many messages per batch request. */
const ARCHIVE_BATCH_SIZE = 50;

export function knockTransport(secretKey: string): NotificationTransport {
  const knock = new Knock({ apiKey: secretKey });
  return {
    async trigger(workflow, trigger) {
      await knock.workflows.trigger(workflow, {
        recipients: trigger.recipients,
        actor: trigger.actor,
        data: trigger.data,
      });
    },
    async archiveMessages(filter) {
      const messageIds: string[] = [];
      for await (const message of knock.messages.list({
        trigger_data: JSON.stringify(filter),
      })) {
        messageIds.push(message.id);
      }
      for (let i = 0; i < messageIds.length; i += ARCHIVE_BATCH_SIZE) {
        await knock.messages.batch.archive({
          message_ids: messageIds.slice(i, i + ARCHIVE_BATCH_SIZE),
        });
      }
    },
  };
}

export function outboxTransport(directory: string): NotificationTransport {
  return {
    async trigger(workflow, trigger) {
      writeToOutbox(directory, `notification-${workflow}`, {
        workflowKey: workflow,
        ...trigger,
      });
    },
    async archiveMessages(filter) {
      writeToOutbox(directory, "notification-archive", { archive: filter });
    },
  };
}

function defaultTransport(): NotificationTransport {
  const { secretKey } = knockConfig();
  return secretKey ? knockTransport(secretKey) : outboxTransport(".outbox");
}

function personFor(user: { id: number; name: string; email: string }) {
  return { id: knockUserId(user.id), name: user.name, email: user.email };
}

function getUser(db: Db, userId: number) {
  return db.select().from(users).where(eq(users.id, userId)).get();
}

function getLessonWithCourse(db: Db, lessonId: number) {
  return db
    .select({
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

/** Runs one Notification, logging rather than throwing if anything fails. */
async function deliver(
  notification: string,
  build: () => Promise<void>
): Promise<void> {
  try {
    await build();
  } catch (error) {
    console.error(`Notification "${notification}" failed`, error);
  }
}

/**
 * Comment reply: tells the author of the parent Comment that `replyId` was
 * posted under it, whoever wrote the Reply. A Reply to one's own Comment sends
 * nothing.
 */
export async function notifyCommentReply(
  db: Db,
  replyId: number,
  transport?: NotificationTransport
): Promise<void> {
  await deliver(NotificationWorkflow.CommentReply, async () => {
    const reply = getCommentById(db, replyId);
    if (!reply || reply.parentId === null) return;

    const parent = getCommentById(db, reply.parentId);
    if (!parent || parent.userId === reply.userId) return;

    const replier = getUser(db, reply.userId);
    const parentAuthor = getUser(db, parent.userId);
    const lesson = getLessonWithCourse(db, reply.lessonId);
    if (!replier || !parentAuthor || !lesson) return;

    await (transport ?? defaultTransport()).trigger(
      NotificationWorkflow.CommentReply,
      {
        recipients: [personFor(parentAuthor)],
        actor: personFor(replier),
        data: {
          comment_id: reply.id,
          actor_name: replier.name,
          lesson_title: lesson.lessonTitle,
          url: commentHref(lesson.courseSlug, lesson.lessonId, reply.id),
        },
      }
    );
  });
}

/**
 * New question: tells the course's owning Instructor that the Question
 * `commentId` was asked on one of their lessons. Knock batches these per
 * lesson over 10 minutes, keyed on `lesson_id`.
 */
export async function notifyNewQuestion(
  db: Db,
  commentId: number,
  transport?: NotificationTransport
): Promise<void> {
  await deliver(NotificationWorkflow.NewQuestion, async () => {
    const question = getCommentById(db, commentId);
    if (!question || question.parentId !== null) return;

    const lesson = getLessonWithCourse(db, question.lessonId);
    if (!lesson) return;

    // Only a Question notifies: a top-level post by staff (the course's
    // Instructor or a Platform Admin) notifies no one.
    const asker = getUser(db, question.userId);
    if (!asker || asker.id === lesson.instructorId) return;
    if (asker.role === UserRole.Admin) return;

    // The owning Instructor only; a Platform Admin never receives it.
    const instructor = getUser(db, lesson.instructorId);
    if (!instructor || instructor.role === UserRole.Admin) return;

    await (transport ?? defaultTransport()).trigger(
      NotificationWorkflow.NewQuestion,
      {
        recipients: [personFor(instructor)],
        actor: personFor(asker),
        data: {
          comment_id: question.id,
          lesson_id: lesson.lessonId,
          actor_name: asker.name,
          lesson_title: lesson.lessonTitle,
          url: commentHref(lesson.courseSlug, lesson.lessonId, question.id),
        },
      }
    );
  });
}

/**
 * Called when a Comment is deleted: archives every Notification whose trigger
 * data carries its `comment_id`, across all recipients, so it drops out of
 * every Feed. Covers Comment reply and New question, batched or not.
 */
export async function archiveCommentNotifications(
  commentId: number,
  transport?: NotificationTransport
): Promise<void> {
  await deliver(`archive comment ${commentId}`, async () => {
    await (transport ?? defaultTransport()).archiveMessages({
      comment_id: commentId,
    });
  });
}
