import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { CourseStatus, UserRole } from "~/db/schema";
import type { Db } from "~/db";
import {
  CommentNotFoundError,
  deleteComment,
  editComment,
  liveCommentIds,
  postComment,
} from "./comments.server";

let db: Db;
let student: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });

  instructor = db
    .insert(schema.users)
    .values({ name: "Sarah", email: "sarah@example.com", role: UserRole.Instructor })
    .returning()
    .get();
  student = db
    .insert(schema.users)
    .values({ name: "Liam", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get();
  const category = db
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  const course = db
    .insert(schema.courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "intro-ts",
      description: "Learn TypeScript.",
      salesCopy: "Learn TypeScript.",
      instructorId: instructor.id,
      categoryId: category.id,
      price: 7900,
      status: CourseStatus.Published,
    })
    .returning()
    .get();
  const courseModule = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: courseModule.id, title: "Lesson 1", position: 1 })
    .returning()
    .get().id;
  otherLessonId = db
    .insert(schema.lessons)
    .values({ moduleId: courseModule.id, title: "Lesson 2", position: 2 })
    .returning()
    .get().id;
});

const asStudent = () => ({ userId: student.id, isStaff: false });
const asInstructor = () => ({ userId: instructor.id, isStaff: true });

describe("postComment", () => {
  it("posts a top-level Comment with its body trimmed", () => {
    const question = postComment(db, student.id, lessonId, null, "  Why?  ");

    expect(question.userId).toBe(student.id);
    expect(question.lessonId).toBe(lessonId);
    expect(question.parentId).toBeNull();
    expect(question.body).toBe("Why?");
  });

  it("posts a Reply under a top-level Comment", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");

    const reply = postComment(db, instructor.id, lessonId, question.id, "Because.");

    expect(reply.parentId).toBe(question.id);
    expect(reply.userId).toBe(instructor.id);
  });

  it("refuses a Reply to a Reply", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");
    const reply = postComment(db, instructor.id, lessonId, question.id, "Because.");

    expect(() =>
      postComment(db, student.id, lessonId, reply.id, "But why?")
    ).toThrow("Replies can only be one level deep");
  });

  it("refuses an empty body", () => {
    expect(() => postComment(db, student.id, lessonId, null, "   ")).toThrow(
      "Comment cannot be empty"
    );
  });
});

describe("editComment", () => {
  it("refuses anyone but the author, even staff", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");

    expect(() =>
      editComment(db, lessonId, question.id, asInstructor(), "Edited.")
    ).toThrow("You can only edit your own comments");
    expect(
      editComment(db, lessonId, question.id, asStudent(), " Why not? ").body
    ).toBe("Why not?");
  });

  it("treats a Comment on another lesson as not found", () => {
    const question = postComment(db, student.id, otherLessonId, null, "Why?");

    expect(() =>
      editComment(db, lessonId, question.id, asStudent(), "Edited.")
    ).toThrow(CommentNotFoundError);
  });

  it("reports a missing Comment before checking the body", () => {
    expect(() => editComment(db, lessonId, 9999, asStudent(), "   ")).toThrow(
      CommentNotFoundError
    );
  });
});

describe("deleteComment", () => {
  it("lets the author delete their own Comment", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");

    const deleted = deleteComment(db, lessonId, question.id, asStudent());

    expect(deleted.deletedAt).not.toBeNull();
  });

  it("lets staff delete someone else's Comment", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");

    const deleted = deleteComment(db, lessonId, question.id, asInstructor());

    expect(deleted.deletedAt).not.toBeNull();
  });

  it("refuses anyone else", () => {
    const comment = postComment(db, instructor.id, lessonId, null, "Welcome!");

    expect(() =>
      deleteComment(db, lessonId, comment.id, asStudent())
    ).toThrow("You can only delete your own comments");
  });

  it("treats a Comment on another lesson as not found", () => {
    const question = postComment(db, student.id, otherLessonId, null, "Why?");

    expect(() =>
      deleteComment(db, lessonId, question.id, asStudent())
    ).toThrow(CommentNotFoundError);
  });
});

describe("liveCommentIds", () => {
  it("returns the Comments still live on the viewer's own courses", () => {
    const kept = postComment(db, student.id, lessonId, null, "Kept?");
    const gone = postComment(db, student.id, otherLessonId, null, "Gone?");
    deleteComment(db, otherLessonId, gone.id, asStudent());

    expect(liveCommentIds(db, instructor.id, [kept.id, gone.id])).toEqual([
      kept.id,
    ]);
  });

  it("says nothing about Comments on someone else's course", () => {
    const question = postComment(db, student.id, lessonId, null, "Why?");

    expect(liveCommentIds(db, student.id, [question.id])).toEqual([]);
  });

  it("ignores ids that don't exist", () => {
    expect(liveCommentIds(db, instructor.id, [999])).toEqual([]);
  });

  it("returns nothing for no ids", () => {
    expect(liveCommentIds(db, instructor.id, [])).toEqual([]);
  });
});
