// ─── Links to a Comment ───
// Where a Comment is rendered on its lesson page, so a link (from a
// Notification, say) can land on it.

/** The DOM id a Comment is rendered with, so a link can land on it. */
export function commentAnchor(commentId: number) {
  return `comment-${commentId}`;
}

/** The path to a Comment on its lesson page. */
export function commentHref(
  courseSlug: string,
  lessonId: number,
  commentId: number
) {
  return `/courses/${courseSlug}/lessons/${lessonId}#${commentAnchor(commentId)}`;
}
