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
// One function per event, called from the action that causes it, after the
// change is written. Each works out which Notification to send, its recipients
// and its trigger data from the database, and hands them to a Notification
// transport. Knock delivers when KNOCK_SECRET_API_KEY is set (ADR 0013).
// Without it (local dev, tests) each trigger, and each archive request, is
// written to .outbox/ as a JSON file instead, as the mailer does.
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

/**
 * A deleted Comment whose Notifications are to be archived. `lesson_id` finds
 * the batched New question messages it may be part of.
 */
export type DeletedComment = { comment_id: number; lesson_id: number };

export interface NotificationTransport {
  trigger<W extends NotificationWorkflow>(
    workflow: W,
    trigger: NotificationTrigger<W>
  ): Promise<void>;
  /**
   * Archives every message, for every recipient, about `comment`: those
   * triggered with its `comment_id`, including a batch it was folded into.
   */
  archiveMessages(comment: DeletedComment): Promise<void>;
}

/**
 * The parts of the Knock client the transport uses, so it can be tested
 * against a fake.
 */
export type KnockClient = {
  workflows: Pick<Knock["workflows"], "trigger">;
  messages: KnockMessagesApi;
};

export type KnockMessagesApi = {
  list(query: {
    source?: string;
    trigger_data: string;
  }): AsyncIterable<{ id: string }>;
  listActivities(
    messageId: string
  ): AsyncIterable<{ data?: Record<string, unknown> | null }>;
  batch: {
    archive(body: { message_ids: string[] }): Promise<unknown>;
  };
};

/**
 * How many message ids go in one batch-archive request. Knock documents no
 * maximum for POST /v1/messages/batch/archived
 * (https://docs.knock.app/api-reference/messages/batch/archive), so this
 * matches the documented "max 50" on the list endpoint's `message_ids`
 * (https://docs.knock.app/api-reference/messages/list) to stay conservative.
 */
const ARCHIVE_BATCH_SIZE = 50;

/**
 * Delivers through Knock. Archiving looks in two places
 * (https://docs.knock.app/designing-workflows/batch-function):
 * - Messages whose trigger data has the `comment_id` (GET /v1/messages with
 *   `trigger_data`, https://docs.knock.app/api-reference/messages/list). That
 *   finds a Comment reply or a lone New question, but a batched message's
 *   data is merged with the newest trigger's values winning, so an earlier
 *   Question's `comment_id` is gone from it.
 * - So New question messages for the Comment's lesson (`source` plus
 *   `trigger_data` on `lesson_id`, the batch key) are checked activity by
 *   activity (GET /v1/messages/{id}/activities,
 *   https://docs.knock.app/api-reference/messages/list_activities), each of
 *   which keeps one trigger's own data. A match archives the whole batch.
 */
export function knockTransport(knock: KnockClient): NotificationTransport {
  const { messages } = knock;
  return {
    async trigger(workflow, trigger) {
      await knock.workflows.trigger(workflow, {
        recipients: trigger.recipients,
        actor: trigger.actor,
        data: trigger.data,
      });
    },
    async archiveMessages({ comment_id, lesson_id }) {
      const messageIds = new Set<string>();
      for await (const message of messages.list({
        trigger_data: JSON.stringify({ comment_id }),
      })) {
        messageIds.add(message.id);
      }
      for await (const message of messages.list({
        source: NotificationWorkflow.NewQuestion,
        trigger_data: JSON.stringify({ lesson_id }),
      })) {
        if (messageIds.has(message.id)) continue;
        for await (const activity of messages.listActivities(message.id)) {
          if (activity.data?.comment_id === comment_id) {
            messageIds.add(message.id);
            break;
          }
        }
      }
      const ids = [...messageIds];
      for (let i = 0; i < ids.length; i += ARCHIVE_BATCH_SIZE) {
        await messages.batch.archive({
          message_ids: ids.slice(i, i + ARCHIVE_BATCH_SIZE),
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
    async archiveMessages(comment) {
      writeToOutbox(directory, "notification-archive", { archive: comment });
    },
  };
}

function defaultTransport(): NotificationTransport {
  const { secretKey } = knockConfig();
  return secretKey
    ? knockTransport(new Knock({ apiKey: secretKey }))
    : outboxTransport(".outbox");
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

type Comment = NonNullable<ReturnType<typeof getCommentById>>;

/** Runs one Notification, logging rather than throwing if anything fails. */
async function deliver(
  notification: NotificationWorkflow,
  build: () => Promise<void>
): Promise<void> {
  try {
    await build();
  } catch (error) {
    console.error(`Notification "${notification}" failed`, error);
  }
}

/**
 * Called when a Comment is posted: a Reply sends Comment reply, a top-level
 * Comment sends New question if it is a Question.
 */
export async function notifyCommentPosted(
  db: Db,
  commentId: number,
  transport: NotificationTransport = defaultTransport()
): Promise<void> {
  const comment = getCommentById(db, commentId);
  if (!comment) return;
  if (comment.parentId === null) {
    await notifyNewQuestion(db, comment, transport);
  } else {
    await notifyCommentReply(db, comment, comment.parentId, transport);
  }
}

/**
 * Comment reply: tells the author of the parent Comment that `reply` was
 * posted under it, whoever wrote the Reply. A Reply to one's own Comment sends
 * nothing.
 */
async function notifyCommentReply(
  db: Db,
  reply: Comment,
  parentId: number,
  transport: NotificationTransport
): Promise<void> {
  await deliver(NotificationWorkflow.CommentReply, async () => {
    const parent = getCommentById(db, parentId);
    if (!parent || parent.userId === reply.userId) return;

    const replier = getUser(db, reply.userId);
    const parentAuthor = getUser(db, parent.userId);
    const lesson = getLessonWithCourse(db, reply.lessonId);
    if (!replier || !parentAuthor || !lesson) return;

    await transport.trigger(NotificationWorkflow.CommentReply, {
      recipients: [personFor(parentAuthor)],
      actor: personFor(replier),
      data: {
        comment_id: reply.id,
        actor_name: replier.name,
        lesson_title: lesson.lessonTitle,
        url: commentHref(lesson.courseSlug, lesson.lessonId, reply.id),
      },
    });
  });
}

/**
 * New question: tells the course's owning Instructor that the top-level
 * Comment `post` was asked on one of their lessons, if it is a Question.
 * Knock batches these per lesson over 10 minutes, keyed on `lesson_id`.
 */
async function notifyNewQuestion(
  db: Db,
  post: Comment,
  transport: NotificationTransport
): Promise<void> {
  await deliver(NotificationWorkflow.NewQuestion, async () => {
    const lesson = getLessonWithCourse(db, post.lessonId);
    if (!lesson) return;

    // Only a Question notifies: a top-level post by staff (the course's
    // Instructor or a Platform Admin) notifies no one.
    const asker = getUser(db, post.userId);
    if (!asker || asker.id === lesson.instructorId) return;
    if (asker.role === UserRole.Admin) return;

    // The owning Instructor only; a Platform Admin never receives it.
    const instructor = getUser(db, lesson.instructorId);
    if (!instructor || instructor.role === UserRole.Admin) return;

    await transport.trigger(NotificationWorkflow.NewQuestion, {
      recipients: [personFor(instructor)],
      actor: personFor(asker),
      data: {
        comment_id: post.id,
        lesson_id: lesson.lessonId,
        actor_name: asker.name,
        lesson_title: lesson.lessonTitle,
        url: commentHref(lesson.courseSlug, lesson.lessonId, post.id),
      },
    });
  });
}

/**
 * Called when a Comment is deleted: archives every Notification about it,
 * across all recipients, so it drops out of every Feed. Covers Comment reply
 * and New question, batched or not; a batch is archived whole.
 */
export async function archiveCommentNotifications(
  db: Db,
  commentId: number,
  transport: NotificationTransport = defaultTransport()
): Promise<void> {
  try {
    const comment = getCommentById(db, commentId);
    if (!comment) return;
    await transport.archiveMessages({
      comment_id: comment.id,
      lesson_id: comment.lessonId,
    });
  } catch (error) {
    console.error(
      `Archiving Notifications for Comment ${commentId} failed`,
      error
    );
  }
}
