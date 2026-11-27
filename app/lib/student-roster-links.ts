// ─── Links to the Student roster ───
// Where a course's Students are rendered for its Instructor, so a link (from a
// Notification, say) can land on the roster or on one Student's row.

/** The DOM id a Student's roster row is rendered with. */
export function studentAnchor(userId: number) {
  return `student-${userId}`;
}

/** The path to a course's Student roster. */
export function studentRosterHref(courseId: number) {
  return `/instructor/${courseId}/students`;
}

/** The path to one Student's row on a course's roster. */
export function studentHref(courseId: number, userId: number) {
  return `${studentRosterHref(courseId)}#${studentAnchor(userId)}`;
}
