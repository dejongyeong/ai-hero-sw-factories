import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Knock } from "@knocklabs/node";
import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { knockConfig, knockUserId } from "~/lib/knock.server";
import { getCommentById } from "~/lib/comments.server";
import { commentHref, NotificationWorkflow } from "~/lib/notifications";

// ─── Notifications ───
// One function per Notification, called from the action that causes it, after
// the change is written. Each works out its recipients and trigger data from
// the database and hands them to a Notification transport. Knock delivers
// when KNOCK_SECRET_API_KEY is set (ADR 0013). Without it (local dev, tests)
// each trigger is written to .outbox/ as a JSON file instead, as the mailer
// does.
//
// A Notification never fails the action that caused it: every function here
// catches and logs instead of throwing.

/** A person identified inline on a trigger, so Knock needs no separate sync. */
export type NotificationRecipient = {
  id: string;
  name: string;
  email: string;
};

export type NotificationTrigger = {
  recipients: NotificationRecipient[];
  actor?: NotificationRecipient;
  data: Record<string, unknown>;
};

export interface NotificationTransport {
  trigger(workflowKey: string, trigger: NotificationTrigger): Promise<void>;
}

export function knockTransport(secretKey: string): NotificationTransport {
  const knock = new Knock({ apiKey: secretKey });
  return {
    async trigger(workflowKey, trigger) {
      await knock.workflows.trigger(workflowKey, {
        recipients: trigger.recipients,
        actor: trigger.actor,
        data: trigger.data,
      });
    },
  };
}

export function outboxTransport(directory: string): NotificationTransport {
  return {
    async trigger(workflowKey, trigger) {
      mkdirSync(directory, { recursive: true });
      const file = join(
        directory,
        `${Date.now()}-notification-${workflowKey}.json`
      );
      writeFileSync(file, JSON.stringify({ workflowKey, ...trigger }, null, 2));
    },
  };
}

function defaultTransport(): NotificationTransport {
  const { secretKey } = knockConfig();
  return secretKey ? knockTransport(secretKey) : outboxTransport(".outbox");
}

function recipientFor(user: { id: number; name: string; email: string }) {
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
      courseTitle: courses.title,
      courseSlug: courses.slug,
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

    const parent = db
      .select()
      .from(comments)
      .where(eq(comments.id, reply.parentId))
      .get();
    if (!parent || parent.userId === reply.userId) return;

    const replier = getUser(db, reply.userId);
    const parentAuthor = getUser(db, parent.userId);
    const lesson = getLessonWithCourse(db, reply.lessonId);
    if (!replier || !parentAuthor || !lesson) return;

    await (transport ?? defaultTransport()).trigger(
      NotificationWorkflow.CommentReply,
      {
        recipients: [recipientFor(parentAuthor)],
        actor: recipientFor(replier),
        data: {
          comment_id: reply.id,
          parent_comment_id: parent.id,
          actor_name: replier.name,
          lesson_id: lesson.lessonId,
          lesson_title: lesson.lessonTitle,
          course_title: lesson.courseTitle,
          course_slug: lesson.courseSlug,
          url: commentHref(lesson.courseSlug, lesson.lessonId, reply.id),
        },
      }
    );
  });
}
