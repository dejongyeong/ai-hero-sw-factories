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
  /**
   * Lets the run be cancelled later
   * (https://docs.knock.app/send-notifications/canceling-workflows).
   */
  cancellationKey?: string;
};

/** Cancels the runs triggered with `cancellationKey`, for `recipients` only. */
export type NotificationCancel = {
  workflow: NotificationWorkflow;
  cancellationKey: string;
  recipients: string[];
};

/**
 * A New question message that was archived because it held a deleted Comment:
 * who it was for, and every Comment it was about, the deleted one included.
 */
export type ArchivedNewQuestion = { recipient: string; comment_ids: number[] };

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
   * Removes a run from a batch that is still open. Has no effect once the
   * batch has closed and its message is delivered.
   */
  cancel(request: NotificationCancel): Promise<void>;
  /**
   * Archives every message, for every recipient, about `comment`: those
   * triggered with its `comment_id`, including a batch it was folded into.
   * Returns the New question messages archived, so their other Questions can
   * be re-sent.
   */
  archiveMessages(comment: DeletedComment): Promise<ArchivedNewQuestion[]>;
  /**
   * Sends New question straight away, skipping the 10-minute batch: used to
   * replace an archived batch with its Questions that are still live.
   */
  resendNewQuestion(
    trigger: NotificationTrigger<typeof NotificationWorkflow.NewQuestion>
  ): Promise<void>;
}

/**
 * The parts of the Knock client the transport uses, so it can be tested
 * against a fake.
 */
export type KnockClient = {
  workflows: Pick<Knock["workflows"], "trigger" | "cancel">;
  messages: KnockMessagesApi;
};

export type KnockMessagesApi = {
  list(query: {
    source?: string;
    trigger_data: string;
  }): AsyncIterable<{ id: string; recipient: string | { id?: string } }>;
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
 * Every Comment a New question message is about, oldest first. Each activity
 * is one trigger: a batched Question carries its `comment_id`, and a re-sent
 * New question also carries `comment_ids`, every Question it stands for.
 */
async function commentIdsIn(
  messages: KnockMessagesApi,
  messageId: string
): Promise<number[]> {
  const ids = new Set<number>();
  for await (const activity of messages.listActivities(messageId)) {
    const data = activity.data ?? {};
    if (typeof data.comment_id === "number") ids.add(data.comment_id);
    if (Array.isArray(data.comment_ids)) {
      for (const id of data.comment_ids) {
        if (typeof id === "number") ids.add(id);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function recipientId(recipient: string | { id?: string }): string {
  return typeof recipient === "string" ? recipient : (recipient.id ?? "");
}

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
 *   A re-sent New question is matched the same way, by the `comment_ids` in
 *   its one activity: `trigger_data` only matches top-level scalar values
 *   (https://docs.knock.app/api-reference/overview/trigger-data-filtering),
 *   so it can't look inside that array.
 */
export function knockTransport(knock: KnockClient): NotificationTransport {
  const { messages } = knock;
  return {
    async trigger(workflow, trigger) {
      await knock.workflows.trigger(workflow, {
        recipients: trigger.recipients,
        actor: trigger.actor,
        data: trigger.data,
        cancellation_key: trigger.cancellationKey,
      });
    },
    // The new-question workflow's Batch step has a step condition,
    // `data.skip_batch` not_equal_to `true`. A step whose conditions fail is
    // skipped and the next step runs (step conditions apply to "all function
    // and channel steps",
    // https://docs.knock.app/designing-workflows/step-conditions), so this
    // goes straight to the Feed step. A missing variable resolves to an empty
    // string (https://docs.knock.app/concepts/conditions), so an ordinary
    // trigger, without the flag, is still batched.
    async resendNewQuestion(trigger) {
      await knock.workflows.trigger(NotificationWorkflow.NewQuestion, {
        recipients: trigger.recipients,
        actor: trigger.actor,
        data: { ...trigger.data, skip_batch: true },
      });
    },
    // POST /v1/workflows/{key}/cancel
    // (https://docs.knock.app/api-reference/workflows/cancel). On an open
    // batch it removes just this run; the window stays open for the rest
    // (https://docs.knock.app/designing-workflows/batch-function).
    async cancel({ workflow, cancellationKey, recipients }) {
      await knock.workflows.cancel(workflow, {
        cancellation_key: cancellationKey,
        recipients,
      });
    },
    async archiveMessages({ comment_id, lesson_id }) {
      const messageIds = new Set<string>();
      for await (const message of messages.list({
        trigger_data: JSON.stringify({ comment_id }),
      })) {
        messageIds.add(message.id);
      }
      // Every New question message on the lesson, a lone one found above
      // included, is read activity by activity, both to find the batches the
      // Comment is in and to report every Question each one held.
      const newQuestions: ArchivedNewQuestion[] = [];
      for await (const message of messages.list({
        source: NotificationWorkflow.NewQuestion,
        trigger_data: JSON.stringify({ lesson_id }),
      })) {
        const commentIds = await commentIdsIn(messages, message.id);
        if (!commentIds.includes(comment_id)) continue;
        messageIds.add(message.id);
        newQuestions.push({
          recipient: recipientId(message.recipient),
          comment_ids: commentIds,
        });
      }
      const ids = [...messageIds];
      for (let i = 0; i < ids.length; i += ARCHIVE_BATCH_SIZE) {
        await messages.batch.archive({
          message_ids: ids.slice(i, i + ARCHIVE_BATCH_SIZE),
        });
      }
      return newQuestions;
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
    async cancel(request) {
      writeToOutbox(directory, "notification-cancel", { cancel: request });
    },
    async archiveMessages(comment) {
      writeToOutbox(directory, "notification-archive", { archive: comment });
      // Nothing was delivered, so no New question needs re-sending.
      return [];
    },
    async resendNewQuestion(resend) {
      writeToOutbox(directory, "notification-new-question-resend", {
        workflowKey: NotificationWorkflow.NewQuestion,
        resend,
      });
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
      cancellationKey: newQuestionCancellationKey(post.id),
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

/** The key a Question's New question run is triggered, and cancelled, with. */
function newQuestionCancellationKey(commentId: number) {
  return `comment-${commentId}`;
}

/**
 * Called when a Comment is deleted, so it drops out of every Feed:
 * - A Question still waiting in an open New question batch is cancelled out
 *   of it. Cancelling is enqueued and does nothing once the batch has closed,
 *   so the next step always runs too.
 * - Every delivered message about the Comment is archived, across all
 *   recipients: Comment reply, and New question batched or not.
 * - Each archived New question is re-sent for its Questions still live. Its
 *   read state isn't carried over: Knock runs a trigger asynchronously, so
 *   the new message doesn't exist yet to be marked read.
 */
export async function archiveCommentNotifications(
  db: Db,
  commentId: number,
  transport: NotificationTransport = defaultTransport()
): Promise<void> {
  let archived: ArchivedNewQuestion[];
  try {
    const comment = getCommentById(db, commentId);
    if (!comment) return;
    if (comment.parentId === null) {
      await cancelNewQuestion(db, comment, transport);
    }
    archived = await transport.archiveMessages({
      comment_id: comment.id,
      lesson_id: comment.lessonId,
    });
  } catch (error) {
    console.error(
      `Archiving Notifications for Comment ${commentId} failed`,
      error
    );
    return;
  }
  for (const message of archived) {
    await resendNewQuestion(db, message, transport);
  }
}

/**
 * Replaces an archived New question with one for its Questions that are still
 * live, sent straight away: one Question reads as asked by its asker, more as
 * a count, and it links to the latest. It carries every live Question's id in
 * `comment_ids`, so the Feed counts them and a later delete finds it again.
 * Sends nothing if none is live, or if the archived message's recipient no
 * longer owns the course.
 */
async function resendNewQuestion(
  db: Db,
  archived: ArchivedNewQuestion,
  transport: NotificationTransport
): Promise<void> {
  await deliver(NotificationWorkflow.NewQuestion, async () => {
    const live = archived.comment_ids
      .map((id) => getCommentById(db, id))
      .filter(
        (comment): comment is Comment =>
          comment !== undefined &&
          comment.deletedAt === null &&
          comment.parentId === null
      )
      .sort((a, b) => a.id - b.id);
    const latest = live.at(-1);
    if (!latest) return;

    const lesson = getLessonWithCourse(db, latest.lessonId);
    if (!lesson) return;
    if (archived.recipient !== knockUserId(lesson.instructorId)) return;
    const instructor = getUser(db, lesson.instructorId);
    const asker = getUser(db, latest.userId);
    if (!instructor || !asker) return;

    await transport.resendNewQuestion({
      recipients: [personFor(instructor)],
      actor: personFor(asker),
      data: {
        comment_id: latest.id,
        comment_ids: live.map((comment) => comment.id),
        lesson_id: lesson.lessonId,
        actor_name: asker.name,
        lesson_title: lesson.lessonTitle,
        url: commentHref(lesson.courseSlug, lesson.lessonId, latest.id),
      },
    });
  });
}

/** Cancels a deleted Question's New question run out of an open batch. */
async function cancelNewQuestion(
  db: Db,
  question: Comment,
  transport: NotificationTransport
): Promise<void> {
  try {
    const lesson = getLessonWithCourse(db, question.lessonId);
    if (!lesson) return;
    await transport.cancel({
      workflow: NotificationWorkflow.NewQuestion,
      cancellationKey: newQuestionCancellationKey(question.id),
      recipients: [knockUserId(lesson.instructorId)],
    });
  } catch (error) {
    console.error(
      `Cancelling New question for Comment ${question.id} failed`,
      error
    );
  }
}
