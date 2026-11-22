import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
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

export type Db = BetterSQLite3Database<typeof schema>;

export function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

function lessonExists(db: Db, lessonId: number) {
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

  if (!lessonExists(db, lessonId)) {
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

/** Edits a Comment's body. Only its author may, and not once it is deleted. */
export function editComment(
  db: Db,
  commentId: number,
  userId: number,
  body: string
) {
  const trimmed = assertValidBody(body);

  const existing = getCommentById(db, commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.deletedAt !== null) {
    throw new Error("Comment has been deleted");
  }
  if (existing.userId !== userId) {
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
 */
export function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean
) {
  const existing = getCommentById(db, commentId);
  if (!existing) {
    throw new Error("Comment not found");
  }
  if (existing.userId !== userId && !isStaff) {
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
