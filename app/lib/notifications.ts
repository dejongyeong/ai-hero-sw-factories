import { z } from "zod";

// ─── Notifications, shared by server and browser ───
// The Knock workflow key for each Notification, the trigger data it carries,
// and how a Feed item turns back into a sentence and a link. The server sends
// NotificationData (see notify.server.ts); the Feed parses it back with the
// same schema, so the two can't drift apart.

export const NotificationWorkflow = {
  CommentReply: "comment-reply",
  NewQuestion: "new-question",
  RefundRequestRaised: "refund-request-raised",
  RefundRequestReceived: "refund-request-received",
  RefundRequestApproved: "refund-request-approved",
  RefundRequestDeclined: "refund-request-declined",
  RefundIssued: "refund-issued",
  // Refund failed is one Notification sent as two workflows, one per
  // recipient, so neither Knock template needs a branch on who reads it.
  RefundFailed: "refund-failed",
  RefundFailedAdmin: "refund-failed-admin",
  NewPurchase: "new-purchase",
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

/** One run of a Notification sentence; names and titles are bold. */
export type SentencePart = { text: string; bold: boolean };

/**
 * The Feed category a Notification is filed under, as shown on its row. Each
 * new workflow adds its category here.
 */
export type FeedCategory = "Discussions" | "Refunds" | "Enrollments";

export type DescribedNotification = {
  sentence: SentencePart[];
  href: string;
  category: FeedCategory;
};

/**
 * Pairs a workflow's trigger data schema with how to describe it. `describe`
 * takes raw Feed data, because Feed data comes from Knock and is parsed, not
 * trusted; it returns null for anything it can't read. `activityCount` is how
 * many triggers a batched Feed item stands for; its data is the latest one's.
 */
function workflow<S extends z.ZodTypeAny>(
  data: S,
  describe: (data: z.infer<S>, activityCount: number) => DescribedNotification
) {
  return {
    data,
    describe(
      raw: unknown,
      activityCount: number
    ): DescribedNotification | null {
      const parsed = data.safeParse(raw);
      return parsed.success ? describe(parsed.data, activityCount) : null;
    },
  };
}

/**
 * What every Notification about a Comment carries: the Comment (so deleting it
 * archives the Notification), who posted it, where, and a link to it.
 */
const commentNotificationData = z.object({
  comment_id: z.number().int(),
  actor_name: z.string(),
  lesson_title: z.string(),
  url: z.string().startsWith("/"),
});

/**
 * What every Notification about a Refund Request carries: the Refund Request,
 * its course, and where the Notification links to.
 */
const refundRequestNotificationData = z.object({
  refund_request_id: z.number().int(),
  course_title: z.string(),
  url: z.string().startsWith("/"),
});

/**
 * What every Notification about a Refund carries: the Refund, its course, and
 * where the Notification links to.
 */
const refundNotificationData = z.object({
  refund_id: z.number().int(),
  course_title: z.string(),
  url: z.string().startsWith("/"),
});

const workflows = {
  [NotificationWorkflow.CommentReply]: workflow(
    commentNotificationData,
    (data) => ({
      sentence: [
        { text: data.actor_name, bold: true },
        { text: " replied to your Comment on ", bold: false },
        { text: data.lesson_title, bold: true },
      ],
      href: data.url,
      category: "Discussions",
    })
  ),
  [NotificationWorkflow.NewQuestion]: workflow(
    // `lesson_id` is the batch key.
    commentNotificationData.extend({ lesson_id: z.number().int() }),
    (data, count) => {
      return {
        sentence:
          count > 1
            ? [
                { text: `${count} new questions`, bold: true },
                { text: " on ", bold: false },
                { text: data.lesson_title, bold: true },
              ]
            : [
                { text: data.actor_name, bold: true },
                { text: " asked a question on ", bold: false },
                { text: data.lesson_title, bold: true },
              ],
        // A batch links to its latest Question: Knock's merged data, or the
        // latest live Question's when the Feed passes it (liveNewQuestion).
        href: data.url,
        category: "Discussions",
      };
    }
  ),
  [NotificationWorkflow.RefundRequestRaised]: workflow(
    refundRequestNotificationData.extend({
      actor_name: z.string(),
      // Already formatted, such as "$79.00", so a Knock template can show it.
      amount: z.string(),
    }),
    (data) => ({
      sentence: [
        { text: data.actor_name, bold: true },
        { text: " requested a refund for ", bold: false },
        { text: data.course_title, bold: true },
        { text: ` (${data.amount})`, bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundRequestReceived]: workflow(
    refundRequestNotificationData,
    (data) => ({
      sentence: [
        { text: "We've got your refund request for ", bold: false },
        { text: data.course_title, bold: true },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundRequestApproved]: workflow(
    refundRequestNotificationData.extend({
      // Already formatted, such as "$79.00", so a Knock template can show it.
      amount: z.string(),
    }),
    (data) => ({
      sentence: [
        { text: "Your refund for ", bold: false },
        { text: data.course_title, bold: true },
        { text: ` was approved — ${data.amount}`, bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundRequestDeclined]: workflow(
    refundRequestNotificationData,
    (data) => ({
      sentence: [
        { text: "Your refund request for ", bold: false },
        { text: data.course_title, bold: true },
        { text: " was declined; you keep access", bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundIssued]: workflow(
    refundNotificationData.extend({
      // Already formatted, such as "$79.00", so a Knock template can show it.
      amount: z.string(),
    }),
    (data) => ({
      sentence: [
        { text: `Your ${data.amount} refund for `, bold: false },
        { text: data.course_title, bold: true },
        { text: " has been sent", bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundFailed]: workflow(
    refundNotificationData,
    (data) => ({
      sentence: [
        { text: "We couldn't send your refund for ", bold: false },
        { text: data.course_title, bold: true },
        { text: "; we're on it", bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.RefundFailedAdmin]: workflow(
    refundNotificationData.extend({
      refund_request_id: z.number().int(),
      student_name: z.string(),
    }),
    (data) => ({
      sentence: [
        { text: "Refund for ", bold: false },
        { text: data.student_name, bold: true },
        { text: " on ", bold: false },
        { text: data.course_title, bold: true },
        { text: " failed", bold: false },
      ],
      href: data.url,
      category: "Refunds",
    })
  ),
  [NotificationWorkflow.NewPurchase]: workflow(
    z.object({
      purchase_id: z.number().int(),
      // The batch key.
      course_id: z.number().int(),
      actor_name: z.string(),
      course_title: z.string(),
      // How many Seats a Team Licence bought; null for an Individual Purchase.
      seat_count: z.number().int().nullable(),
      url: z.string().startsWith("/"),
    }),
    (data, count) => ({
      sentence:
        count > 1
          ? [
              { text: `${count} new purchases`, bold: true },
              { text: " of ", bold: false },
              { text: data.course_title, bold: true },
            ]
          : [
              { text: data.actor_name, bold: true },
              {
                text:
                  data.seat_count === null
                    ? " bought "
                    : ` bought ${data.seat_count} ${data.seat_count === 1 ? "seat" : "seats"} on `,
                bold: false,
              },
              { text: data.course_title, bold: true },
            ],
      // A batch links to its latest buyer, from Knock's merged data.
      href: data.url,
      category: "Enrollments",
    })
  ),
} satisfies Record<NotificationWorkflow, unknown>;

/** The trigger data a workflow carries, as the server sends it. */
export type NotificationData<W extends NotificationWorkflow> = z.infer<
  (typeof workflows)[W]["data"]
>;

/** Whether a Feed item's workflow key is one Cadence knows. */
export function isNotificationWorkflow(
  key: string
): key is NotificationWorkflow {
  return Object.hasOwn(workflows, key);
}

/**
 * Turns a Feed item's workflow key and trigger data back into its sentence and
 * link. `activityCount` is how many triggers Knock batched into the item.
 * Returns null for an unknown workflow or data it can't read.
 */
export function describeNotification(
  workflowKey: string,
  data: unknown,
  activityCount = 1
): DescribedNotification | null {
  if (!isNotificationWorkflow(workflowKey)) return null;
  return workflows[workflowKey].describe(data, activityCount);
}

// ─── New question: what is still live ───
// A delivered New question can hold Questions deleted since: a delete after
// the batch window closed can't be cancelled out of it, and the message is
// only archived once every Question in it is deleted. So the Feed counts it at
// render time, against the Comment ids the app says are still live. The Feed
// must be loaded in Knock's "rich" mode, or items carry neither
// `total_activities` nor `activities`.

/** A Feed item, as far as counting a New question needs it. */
export type NewQuestionItem = {
  data: unknown;
  total_activities?: number;
  activities?: { data: unknown }[];
};

type ListedQuestion = { comment_id: number; data: unknown };

function commentIdOf(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { comment_id?: unknown }).comment_id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

/** Each Question the item lists, one per activity, or its own data if none. */
function questionsIn(item: NewQuestionItem): ListedQuestion[] {
  const sources = item.activities?.length
    ? item.activities.map((activity) => activity.data)
    : [item.data];
  return sources.flatMap((data) => {
    const comment_id = commentIdOf(data);
    return comment_id === null ? [] : [{ comment_id, data }];
  });
}

/** The Question ids a New question Feed item lists, to check for liveness. */
export function newQuestionCommentIds(item: NewQuestionItem): number[] {
  return [...new Set(questionsIn(item).map((q) => q.comment_id))];
}

/**
 * What a New question Feed item shows once deleted Questions are left out:
 * how many are live, and the data to describe it by, which is the latest live
 * Question's, so a lone survivor reads as asked by its asker and the row links
 * to it. Null when none is live, so the row is hidden. `live` null means the
 * check couldn't be made: Knock's count and data are shown as they are.
 *
 * Knock lists at most 10 activities on a batched item by default
 * (https://docs.knock.app/designing-workflows/batch-function: `activities` is
 * "a list of up to ten of the activity objects included within the batch"),
 * while `total_activities` counts every run
 * (https://docs.knock.app/in-app-ui/api-overview). So the count is the total
 * minus the deleted Questions it can see; a deleted one beyond those listed is
 * still counted.
 */
export function liveNewQuestion(
  item: NewQuestionItem,
  live: ReadonlySet<number> | null
): { count: number; data: unknown } | null {
  const total = item.total_activities ?? 1;
  if (live === null) return { count: total, data: item.data };
  const questions = questionsIn(item);
  const deleted = questions.filter((q) => !live.has(q.comment_id)).length;
  const count = total - deleted;
  if (count <= 0) return null;
  // Comment ids grow with time, so the highest live one is the latest.
  const latest = questions
    .filter((q) => live.has(q.comment_id))
    .sort((a, b) => a.comment_id - b.comment_id)
    .at(-1);
  // When every live Question is beyond those listed, keep Knock's data.
  return { count, data: latest?.data ?? item.data };
}
