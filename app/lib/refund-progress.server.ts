import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  videoWatchEvents,
  LessonProgressStatus,
} from "~/db/schema";
import type { PurchaseKind, RefundProgress } from "~/lib/refund-decisions";

/** Only a Team Purchase has Seats. */
export function getPurchaseKind(purchaseId: number): PurchaseKind {
  const seat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
  return seat ? "team" : "individual";
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/**
 * The Progress the Watch Limit and Completion Limit are measured against:
 * lessons completed, counted against the course as it is now, and Watched —
 * the furthest point reached in each lesson's video, added up.
 */
export function getRefundProgress(
  userId: number,
  courseId: number
): RefundProgress {
  const lessonIds = getLessonIdsForCourse(courseId);
  if (lessonIds.length === 0) {
    return { completedLessons: 0, totalLessons: 0, secondsWatched: 0 };
  }

  const completed = db
    .select({ total: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return {
    completedLessons: completed?.total ?? 0,
    totalLessons: lessonIds.length,
    secondsWatched: furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    ),
  };
}
