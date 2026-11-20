// PROTOTYPE — throwaway, prototype/notification-feed branch only.
// The /notifications page that Variant B links to. Other variants can still
// open it, to compare the page against their popover or drawer.
import { data } from "react-router";
import type { Route } from "./+types/prototype.notifications-page";
import { getCurrentUserId } from "~/lib/session";
import { VariantBPage } from "~/components/prototype-notification-feed";

export async function loader({ request }: Route.LoaderArgs) {
  // No user → no Knock session in the layout → no Feed to read.
  if (!(await getCurrentUserId(request)))
    throw data("Select a user from the DevUI panel.", { status: 401 });
  return null;
}

export default function NotificationsPage() {
  return <VariantBPage />;
}
