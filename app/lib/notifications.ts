import { z } from "zod";

// ─── Notifications, shared by server and browser ───
// The Knock workflow key for each Notification, and how a Feed item turns
// back into a sentence and a link. The server puts these ids in the trigger
// data (see notify.server.ts); the Feed reads them back out.

export const NotificationWorkflow = {
  CommentReply: "comment-reply",
} as const;

export type NotificationWorkflow =
  (typeof NotificationWorkflow)[keyof typeof NotificationWorkflow];

/** What the browser needs to open a person's Notification Feed. */
export type KnockFeedSession = {
  userId: string;
  userToken: string;
  publicKey: string;
  feedChannelId: string;
};

/** The DOM id a Comment is rendered with, so a link can land on it. */
export function commentAnchor(commentId: number) {
  return `comment-${commentId}`;
}

/** One run of a Notification sentence; names and titles are bold. */
export type SentencePart = { text: string; bold: boolean };

export type DescribedNotification = {
  sentence: SentencePart[];
  href: string;
};

const commentReplyData = z.object({
  actor_name: z.string(),
  lesson_title: z.string(),
  url: z.string().startsWith("/"),
});

/**
 * Turns a Feed item's workflow key and trigger data back into its sentence and
 * link. Feed data comes from Knock, so it is parsed, not trusted. Returns null
 * for anything it can't read.
 */
export function describeNotification(
  workflowKey: string,
  data: unknown
): DescribedNotification | null {
  if (workflowKey === NotificationWorkflow.CommentReply) {
    const parsed = commentReplyData.safeParse(data);
    if (!parsed.success) return null;
    return {
      sentence: [
        { text: parsed.data.actor_name, bold: true },
        { text: " replied to your comment on ", bold: false },
        { text: parsed.data.lesson_title, bold: true },
      ],
      href: parsed.data.url,
    };
  }
  return null;
}

export function commentHref(
  courseSlug: string,
  lessonId: number,
  commentId: number
) {
  return `/courses/${courseSlug}/lessons/${lessonId}#${commentAnchor(commentId)}`;
}
