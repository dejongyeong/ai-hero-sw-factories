// PROTOTYPE — throwaway, prototype/notification-feed branch only.
// POST intent=seed → every catalogue entry for the current user, oldest first.
// POST intent=one  → one random entry, to watch a live arrival.
// POST intent=hundred → 100 random entries, to judge pagination.
import { data } from "react-router";
import type { Route } from "./+types/prototype.feed-seed";
import { getCurrentUserId } from "~/lib/session";
import { catalogueFor, triggerOne } from "~/lib/prototype-feed.server";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Select a user from the DevUI panel.", { status: 401 });
  const intent = (await request.formData()).get("intent");
  const entries = catalogueFor(userId);
  const random = () => entries[Math.floor(Math.random() * entries.length)];
  if (intent === "hundred") {
    const picked = Array.from({ length: 100 }, random);
    for (let i = 0; i < picked.length; i += 10)
      await Promise.all(picked.slice(i, i + 10).map((n) => triggerOne(userId, n)));
    return { triggered: picked.length };
  }
  const picked = intent === "one" ? [random()] : entries;
  for (const n of picked) {
    await triggerOne(userId, n);
    // Keep inserted_at ordering stable so the newest entry tops the Feed.
    if (picked.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  return { triggered: picked.map((n) => n.kind) };
}
