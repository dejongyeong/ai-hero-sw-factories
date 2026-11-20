// PROTOTYPE — throwaway. Lives only on the `prototype/notification-feed` branch; never merge.
// Answers "What the Notification Feed looks like" (dejongyeong/ai-hero-sw-factories#8).
// Knock plumbing for the layout plus a builder that turns the Notification
// catalogue (#5) into real Knock messages for the current user, using real
// seeded names, courses and lessons so the Feed is judged at real density.
import { Knock, signUserToken } from "@knocklabs/node";
import { and, eq, ne } from "drizzle-orm";
import { isNotNull, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  lessons,
  refundRequests,
  modules,
  teamMembers,
  TeamMemberRole,
  users,
  UserRole,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

try {
  process.loadEnvFile(".env");
} catch {}

// Reuses the workflow from "Try Knock in Cadence": in-app body is {{ data.message }}.
export const WORKFLOW = process.env.KNOCK_PROTOTYPE_WORKFLOW ?? "prototype-knock";

export function knock() {
  return new Knock({ apiKey: process.env.KNOCK_SECRET_API_KEY });
}

export const knockIdFor = (userId: number) => `cadence-${userId}`;

export async function knockSession(userId: number, name: string) {
  const knockId = knockIdFor(userId);
  // No email on the Knock user: every prototype trigger is also sandboxed.
  await knock().users.update(knockId, { name });
  const userToken = await signUserToken(knockId, {
    signingKey: process.env.KNOCK_SIGNING_KEY,
    expiresInSeconds: 3600,
  });
  return {
    knockId,
    userToken,
    publicKey: process.env.KNOCK_PUBLIC_API_KEY!,
    feedId: process.env.KNOCK_FEED_CHANNEL_ID!,
  };
}

export type NotificationKind =
  | "comment-reply"
  | "new-question"
  | "refund-raised"
  | "refund-received"
  | "refund-approved"
  | "refund-declined"
  | "refund-issued"
  | "refund-failed"
  | "new-purchase"
  | "seat-claimed";

// Feed filters. Real code would put each workflow in a Knock workflow category
// and filter with `workflow_categories`; the prototype has one workflow, so it
// filters on `trigger_data.category` instead (also server-side, also paginates).
export type Category = "discussions" | "refunds" | "team" | "enrollments";
const CATEGORY: Record<NotificationKind, Category> = {
  "comment-reply": "discussions",
  "new-question": "discussions",
  "refund-raised": "refunds",
  "refund-received": "refunds",
  "refund-approved": "refunds",
  "refund-declined": "refunds",
  "refund-issued": "refunds",
  "refund-failed": "refunds",
  "new-purchase": "enrollments",
  "seat-claimed": "team",
};

/** The filters worth showing: only categories this person can ever receive. */
export function categoriesFor(userId: number): Category[] {
  return [...new Set(catalogueFor(userId).map((n) => n.category))];
}

export type PrototypeNotification = {
  kind: NotificationKind;
  category: Category;
  message: string; // markdown, what Knock's stock cell renders
  actor: string | null;
  course: string;
  url: string;
};

function firstLesson(courseId: number) {
  return db
    .select({ id: lessons.id, title: lessons.title })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .get();
}

/** The catalogue entries this user would receive, newest last. */
export function catalogueFor(userId: number): PrototypeNotification[] {
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const other =
    db
      .select()
      .from(users)
      .where(and(ne(users.id, userId), eq(users.role, UserRole.Student)))
      .get() ?? me;
  const owned = db
    .select()
    .from(courses)
    .where(eq(courses.instructorId, userId))
    .get();
  const course = owned ?? db.select().from(courses).get()!;
  const lesson = firstLesson(course.id);
  const lessonTitle = lesson?.title ?? "Lesson 1";
  const lessonUrl = lesson
    ? `/courses/${course.slug}/lessons/${lesson.id}`
    : `/courses/${course.slug}`;
  const amount = formatPrice(course.price);
  const C = course.title;
  const out: PrototypeNotification[] = [];
  const add = (n: Omit<PrototypeNotification, "course" | "category">) =>
    out.push({ ...n, course: C, category: CATEGORY[n.kind] });
  // Real records to deep-link to: the most specific place we can.
  const question = db.select().from(comments).where(isNull(comments.parentId)).get();
  const reply = db.select().from(comments).where(isNotNull(comments.parentId)).get();
  const commentUrl = (c: typeof question) => {
    if (!c) return lessonUrl;
    const l = db
      .select({ courseSlug: courses.slug })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(lessons.id, c.lessonId))
      .get();
    return `/courses/${l?.courseSlug ?? course.slug}/lessons/${c.lessonId}#comment-${c.id}`;
  };
  const refundRequest = db.select().from(refundRequests).get();
  const refundUrl = refundRequest
    ? `/admin/refund-requests?status=${refundRequest.status}#refund-request-${refundRequest.id}`
    : "/admin/refund-requests";

  if (me.role === UserRole.Student) {
    add({
      kind: "refund-received",
      actor: null,
      message: `We've got your refund request for **${C}**`,
      url: `/courses/${course.slug}`,
    });
    add({
      kind: "refund-declined",
      actor: null,
      message: `Your refund request for **${C}** was declined; you keep access`,
      url: `/courses/${course.slug}`,
    });
    add({
      kind: "refund-approved",
      actor: null,
      message: `Your refund for **${C}** was approved — ${amount}`,
      url: `/courses/${course.slug}`,
    });
    add({
      kind: "refund-failed",
      actor: null,
      message: `We couldn't send your refund for **${C}**; we're on it`,
      url: `/courses/${course.slug}`,
    });
    add({
      kind: "refund-issued",
      actor: null,
      message: `Your ${amount} refund for **${C}** has been sent`,
      url: `/courses/${course.slug}`,
    });
  }
  if (me.role === UserRole.Instructor) {
    add({
      kind: "new-purchase",
      actor: other.name,
      message: `**${other.name}** bought **${C}**`,
      url: `/instructor/${course.id}/students#student-${other.id}`,
    });
    add({
      kind: "new-purchase",
      actor: other.name,
      message: `**${other.name}** bought 10 seats on **${C}**`,
      url: `/instructor/${course.id}/students#student-${other.id}`,
    });
    add({
      kind: "new-question",
      actor: other.name,
      message: `**${other.name}** asked a question on **${lessonTitle}**`,
      url: commentUrl(question),
    });
  }
  if (me.role === UserRole.Admin) {
    add({
      kind: "refund-raised",
      actor: other.name,
      message: `**${other.name}** requested a refund for **${C}** (${amount})`,
      url: refundUrl,
    });
    add({
      kind: "refund-failed",
      actor: other.name,
      message: `Refund for **${other.name}** on **${C}** failed`,
      url: refundUrl,
    });
  }
  const isTeamAdmin = !!db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  if (isTeamAdmin) {
    add({
      kind: "seat-claimed",
      actor: other.name,
      message: `**${other.name}** claimed a seat on **${C}** (3/10)`,
      url: "/team",
    });
  }
  // Everyone can get a Comment reply; newest, so it tops the Feed.
  add({
    kind: "comment-reply",
    actor: other.name,
    message: `**${other.name}** replied to your comment on **${lessonTitle}**`,
    url: commentUrl(reply),
  });
  return out;
}

export async function triggerOne(userId: number, n: PrototypeNotification) {
  return knock().workflows.trigger(WORKFLOW, {
    recipients: [knockIdFor(userId)],
    data: n,
    // Feed messages still land; the email step is skipped.
    settings: { sandbox_mode: true },
  } as never);
}
