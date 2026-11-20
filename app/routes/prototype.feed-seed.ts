// PROTOTYPE — throwaway, prototype/notification-feed branch only.
// POST intent=seed → every catalogue entry for the current user, oldest first.
// POST intent=one  → one random entry, to watch a live arrival.
import { data } from "react-router";
import type { Route } from "./+types/prototype.feed-seed";
import { getCurrentUserId } from "~/lib/session";
import { catalogueFor, triggerOne } from "~/lib/prototype-feed.server";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Select a user from the DevUI panel.", { status: 401 });
  const intent = (await request.formData()).get("intent");
  const entries = catalogueFor(userId);
  const picked =
    intent === "one"
      ? [entries[Math.floor(Math.random() * entries.length)]]
      : entries;
  for (const n of picked) {
    await triggerOne(userId, n);
    // Keep inserted_at ordering stable so the newest entry tops the Feed.
    if (picked.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  return { triggered: picked.map((n) => n.kind) };
}
