import { eq } from "drizzle-orm";
import type { Db } from "~/db";
import { comments, courses, lessons, modules } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";

// ─── Comments ───
// Posting, editing and deleting a Comment (a Question, a Reply, or a top-level
// post by staff). The lesson page and the Instructor questions page both write
// Comments through here, so this is the one place to hook Notifications in.
// See GLOSSARY.md for the language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention). Failures the user can
// correct are thrown as Errors whose message is safe to show.

/** Who is editing or deleting a Comment. */
export type CommentActor = {
  userId: number;
  /** The course's Instructor or a Platform Admin. */
  isStaff: boolean;
};

/**
 * Thrown when a Comment does not exist on the lesson it was asked for. Not a
 * user-correctable failure: routes turn it into a 404.
 */
export class CommentNotFoundError extends Error {
  constructor() {
    super("Comment not found");
    this.name = "CommentNotFoundError";
  }
}

export function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

/**
 * Looks a Comment up scoped to a lesson, so a Comment elsewhere can't be
 * reached by posting its id against this lesson.
 */
function getCommentOnLesson(db: Db, lessonId: number, commentId: number) {
  const comment = getCommentById(db, commentId);
  if (!comment || comment.lessonId !== lessonId) {
    throw new CommentNotFoundError();
  }
  return comment;
}

function lessonBelongsToCourse(db: Db, lessonId: number) {
  return (
    db
      .select({ id: courses.id })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(lessons.id, lessonId))
      .get() !== undefined
  );
}

function assertValidBody(body: string) {
  const trimmed = body.trim();
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/**
 * Posts a Comment on a lesson. With a `parentId` it is a Reply, which must sit
 * directly under a top-level Comment on the same lesson.
 */
export function postComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string
) {
  const trimmed = assertValidBody(body);

  if (!lessonBelongsToCourse(db, lessonId)) {
    throw new Error("Lesson not found");
  }

  if (parentId !== null) {
    const parent = getCommentById(db, parentId);
    if (!parent) {
      throw new Error("Parent comment not found");
    }
    if (parent.lessonId !== lessonId) {
      throw new Error("Parent comment belongs to a different lesson");
    }
    if (parent.parentId !== null) {
      throw new Error("Replies can only be one level deep");
    }
  }

  return db
    .insert(comments)
    .values({ userId, lessonId, parentId, body: trimmed })
    .returning()
    .get();
}

/**
 * Edits a Comment's body. Only its author may, and not once it is deleted.
 * Throws CommentNotFoundError if the Comment is not on `lessonId`.
 */
export function editComment(
  db: Db,
  lessonId: number,
  commentId: number,
  actor: CommentActor,
  body: string
) {
  const existing = getCommentOnLesson(db, lessonId, commentId);
  const trimmed = assertValidBody(body);

  if (existing.deletedAt !== null) {
    throw new Error("Comment has been deleted");
  }
  if (existing.userId !== actor.userId) {
    throw new Error("You can only edit your own comments");
  }

  return db
    .update(comments)
    .set({ body: trimmed, editedAt: new Date().toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}

/**
 * Soft-deletes a Comment. Its author may, and so may staff (the course's
 * Instructor or a Platform Admin). Deleting it again is a no-op.
 * Throws CommentNotFoundError if the Comment is not on `lessonId`.
 */
export function deleteComment(
  db: Db,
  lessonId: number,
  commentId: number,
  actor: CommentActor
) {
  const existing = getCommentOnLesson(db, lessonId, commentId);
  if (existing.userId !== actor.userId && !actor.isStaff) {
    throw new Error("You can only delete your own comments");
  }
  if (existing.deletedAt !== null) {
    return existing;
  }

  return db
    .update(comments)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
}
