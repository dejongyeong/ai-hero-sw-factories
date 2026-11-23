import { Knock } from "@knocklabs/node";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "~/db";
import {
  UserRole,
  courses,
  lessons,
  modules,
  purchases,
  refundRequests,
  users,
} from "~/db/schema";
import { knockConfig, knockUserId } from "~/lib/knock.server";
import { getCommentById } from "~/lib/comments.server";
import { writeToOutbox } from "~/lib/outbox.server";
import { commentHref } from "~/lib/comment-links";
import { courseHref } from "~/lib/course-links";
import { refundRequestHref } from "~/lib/refund-request-links";
import { formatPrice } from "~/lib/utils";
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
 * A deleted Comment whose Notifications are to be archived. `lesson_id` finds
 * the batched New question messages it may be part of.
 */
export type DeletedComment = { comment_id: number; lesson_id: number };

/** Whether a Comment is gone: soft-deleted, or no longer there at all. */
export type IsCommentDeleted = (commentId: number) => boolean;

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
   * Archives, for every recipient, each delivered message `comment` leaves
   * with nothing live to show: a Comment reply about it, and a New question
   * holding it once every Question in it is deleted (`isDeleted`). A New
   * question with a Question still live stays; the Feed counts it without the
   * deleted ones (see liveNewQuestion).
   */
  archiveMessages(
    comment: DeletedComment,
    isDeleted: IsCommentDeleted
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
  }): AsyncIterable<{ id: string; archived_at?: string | null }>;
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
 * Every Question a New question message is about. Each activity is one
 * trigger, and keeps that Question's own `comment_id`.
 */
async function commentIdsIn(
  messages: KnockMessagesApi,
  messageId: string
): Promise<number[]> {
  const ids = new Set<number>();
  for await (const activity of messages.listActivities(messageId)) {
    const id = activity.data?.comment_id;
    if (typeof id === "number") ids.add(id);
  }
  return [...ids];
}

/**
 * Delivers through Knock. Knock's message list includes archived messages,
 * so each lookup skips those already archived. Archiving looks in two places
 * (https://docs.knock.app/designing-workflows/batch-function):
 * - Comment reply messages whose trigger data has the `comment_id` (GET
 *   /v1/messages with `source` and `trigger_data`,
 *   https://docs.knock.app/api-reference/messages/list).
 * - New question messages for the Comment's lesson (`trigger_data` on
 *   `lesson_id`, the batch key), read activity by activity (GET
 *   /v1/messages/{id}/activities,
 *   https://docs.knock.app/api-reference/messages/list_activities). A
 *   batched message's own data is merged with the newest trigger's values
 *   winning, so only its activities say which Questions it holds. It is
 *   archived only when it holds the Comment and every Question in it is
 *   deleted.
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
    async archiveMessages({ comment_id, lesson_id }, isDeleted) {
      const messageIds = new Set<string>();
      for await (const message of messages.list({
        source: NotificationWorkflow.CommentReply,
        trigger_data: JSON.stringify({ comment_id }),
      })) {
        if (!message.archived_at) messageIds.add(message.id);
      }
      for await (const message of messages.list({
        source: NotificationWorkflow.NewQuestion,
        trigger_data: JSON.stringify({ lesson_id }),
      })) {
        if (message.archived_at) continue;
        const commentIds = await commentIdsIn(messages, message.id);
        if (!commentIds.includes(comment_id)) continue;
        if (commentIds.every(isDeleted)) messageIds.add(message.id);
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
    async cancel(request) {
      writeToOutbox(directory, "notification-cancel", { cancel: request });
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
 * - Its Comment reply messages are archived, across all recipients, and so is
 *   a delivered New question holding it once every Question in it is deleted.
 *   One with a Question still live stays, and the Feed counts only the live
 *   ones (liveNewQuestion). That also covers a delete just after the window
 *   closed, too late to cancel and before the message exists to archive.
 */
export async function archiveCommentNotifications(
  db: Db,
  commentId: number,
  transport: NotificationTransport = defaultTransport()
): Promise<void> {
  try {
    const comment = getCommentById(db, commentId);
    if (!comment) return;
    if (comment.parentId === null) {
      await cancelNewQuestion(db, comment, transport);
    }
    await transport.archiveMessages(
      { comment_id: comment.id, lesson_id: comment.lessonId },
      (id) => {
        const question = getCommentById(db, id);
        return !question || question.deletedAt !== null;
      }
    );
  } catch (error) {
    console.error(
      `Archiving Notifications for Comment ${commentId} failed`,
      error
    );
  }
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

/**
 * What a Refund Request's Notifications say: its amount, its course, and who
 * raised it. refund_requests has no raised-by column; the Purchase's buyer
 * is the raiser, because raiseRefundRequest refuses anyone else.
 */
function getRefundRequestForNotification(db: Db, refundRequestId: number) {
  return db
    .select({
      id: refundRequests.id,
      amountPaid: purchases.amountPaid,
      raiserId: purchases.userId,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

/** Every Platform Admin except the given user. */
function getOtherPlatformAdmins(db: Db, userId: number) {
  return db
    .select()
    .from(users)
    .where(and(eq(users.role, UserRole.Admin), ne(users.id, userId)))
    .orderBy(users.id)
    .all();
}

/**
 * Called when a Refund Request is raised:
 * - Refund Request raised tells every Platform Admin but the one who raised
 *   it, who can't decide it (see GLOSSARY.md, Refund Request).
 * - Refund Request received tells the person who raised it that it arrived.
 * Each is sent on its own, so one failing doesn't stop the other. The
 * "Refund requested" email still goes out through the mailer, not here.
 */
export async function notifyRefundRequestRaised(
  db: Db,
  refundRequestId: number,
  transport: NotificationTransport = defaultTransport()
): Promise<void> {
  try {
    const request = getRefundRequestForNotification(db, refundRequestId);
    const raiser = request && getUser(db, request.raiserId);
    if (!request || !raiser) return;

    await deliver(NotificationWorkflow.RefundRequestRaised, async () => {
      const admins = getOtherPlatformAdmins(db, raiser.id);
      if (admins.length === 0) return;

      await transport.trigger(NotificationWorkflow.RefundRequestRaised, {
        recipients: admins.map(personFor),
        actor: personFor(raiser),
        data: {
          refund_request_id: request.id,
          actor_name: raiser.name,
          course_title: request.courseTitle,
          amount: formatPrice(request.amountPaid),
          url: refundRequestHref(request.id),
        },
      });
    });

    // Always sent: its Knock workflow is marked so it can't be switched off.
    await deliver(NotificationWorkflow.RefundRequestReceived, async () => {
      await transport.trigger(NotificationWorkflow.RefundRequestReceived, {
        recipients: [personFor(raiser)],
        data: {
          refund_request_id: request.id,
          course_title: request.courseTitle,
          url: courseHref(request.courseSlug),
        },
      });
    });
  } catch (error) {
    console.error(
      `Notifications for Refund Request ${refundRequestId} failed`,
      error
    );
  }
}
