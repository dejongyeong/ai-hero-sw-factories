import { z } from "zod";

// ─── Notifications, shared by server and browser ───
// The Knock workflow key for each Notification, the trigger data it carries,
// and how a Feed item turns back into a sentence and a link. The server sends
// NotificationData (see notify.server.ts); the Feed parses it back with the
// same schema, so the two can't drift apart.

export const NotificationWorkflow = {
  CommentReply: "comment-reply",
  NewQuestion: "new-question",
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
export type FeedCategory = "Discussions";

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
    describe(raw: unknown, activityCount: number): DescribedNotification | null {
      const parsed = data.safeParse(raw);
      return parsed.success ? describe(parsed.data, activityCount) : null;
    },
  };
}

const workflows = {
  [NotificationWorkflow.CommentReply]: workflow(
    z.object({
      comment_id: z.number().int(),
      actor_name: z.string(),
      lesson_title: z.string(),
      url: z.string().startsWith("/"),
    }),
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
    z.object({
      comment_id: z.number().int(),
      lesson_id: z.number().int(),
      actor_name: z.string(),
      lesson_title: z.string(),
      url: z.string().startsWith("/"),
    }),
    (data, activityCount) => ({
      sentence:
        activityCount > 1
          ? [
              { text: `${activityCount} new questions`, bold: true },
              { text: " on ", bold: false },
              { text: data.lesson_title, bold: true },
            ]
          : [
              { text: data.actor_name, bold: true },
              { text: " asked a question on ", bold: false },
              { text: data.lesson_title, bold: true },
            ],
      // A batch links to its latest Question.
      href: data.url,
      category: "Discussions",
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
