// ─── Notifications, shared by server and browser ───
// The Knock workflow key for each Notification, and how a Feed item turns
// back into a sentence and a link. The server puts these ids in the trigger
// data (see notify.server.ts); the Feed reads them back out.

export const NotificationWorkflow = {
  CommentReply: "comment-reply",
} as const;

export type NotificationWorkflow =
  (typeof NotificationWorkflow)[keyof typeof NotificationWorkflow];

/** The DOM id a Comment is rendered with, so a link can land on it. */
export function commentAnchor(commentId: number) {
  return `comment-${commentId}`;
}

export function commentHref(
  courseSlug: string,
  lessonId: number,
  commentId: number
) {
  return `/courses/${courseSlug}/lessons/${lessonId}#${commentAnchor(commentId)}`;
}
