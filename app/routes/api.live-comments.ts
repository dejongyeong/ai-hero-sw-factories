import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.live-comments";
import { db } from "~/db";
import { requireUserId } from "~/lib/access.server";
import { liveCommentIds } from "~/lib/comments.server";
import { parseJsonBody } from "~/lib/validation";

// ─── Live Comments ───
// POST { commentIds } → { liveIds }: which of those Comments are still live.
// The Notification Feed asks this to count a New question without the
// Questions deleted since it was delivered (see liveNewQuestion).
//
// Access: any signed-in user may ask, but only Comments on courses they own
// as Instructor come back. Any other id is left out exactly as a deleted one
// is, so the answer says nothing about Comments they can't see.

/**
 * The popover holds at most 50 rows, each listing up to 10 activities by
 * default (up to 100 on Knock's Enterprise plan), so 1000 is ample.
 */
const MAX_IDS = 1000;

const liveCommentsSchema = z.object({
  commentIds: z.array(z.number().int().positive()).max(MAX_IDS),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw data("Method not allowed", { status: 405 });
  }
  const userId = await requireUserId(request);

  const parsed = await parseJsonBody(request, liveCommentsSchema).catch(
    () => null
  );
  if (!parsed?.success) {
    throw data("Invalid parameters", { status: 400 });
  }

  return Response.json({
    liveIds: liveCommentIds(db, userId, parsed.data.commentIds),
  });
}
