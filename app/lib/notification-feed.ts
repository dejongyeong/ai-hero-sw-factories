// ─── Notification Feed: the popover's decisions ───
// The pure rules behind the bell's popover, kept out of the component so they
// can be tested: how rows are grouped by day, how far the popover pages, which
// state its body shows, and when the "Powered by Knock" footer appears.

export type DayLabel = "Today" | "Yesterday" | "Earlier";

export type DayGroup<T> = { label: DayLabel; items: T[] };

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayLabel(iso: string, now: Date): DayLabel {
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = new Date(iso).getTime();
  if (time >= today.getTime()) return "Today";
  if (time >= yesterday.getTime()) return "Yesterday";
  return "Earlier";
}

/**
 * Groups newest-first Feed items under Today, Yesterday and Earlier, by the
 * person's local calendar day. Order within and between groups is kept.
 */
export function groupByDay<T extends { inserted_at: string }>(
  items: T[],
  now: Date
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const label = dayLabel(item.inserted_at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** The popover loads this many Notifications at a time as you scroll. */
export const POPOVER_PAGE_SIZE = 20;
/** The popover stops here; the Notifications page holds the rest. */
export const POPOVER_CAP = 50;

export type PopoverPage<T> = {
  /** The rows to show, never more than the cap. */
  visible: T[];
  /** How many to ask for on the next scroll, or null to stop loading. */
  nextPageSize: number | null;
  /** "Showing the latest 50 of N" once the cap hides some, otherwise null. */
  capNote: string | null;
};

/**
 * Decides what the popover shows of the loaded Feed: up to POPOVER_CAP rows,
 * loaded POPOVER_PAGE_SIZE at a time, then a note saying how many exist.
 */
export function popoverPage<T>(
  loaded: T[],
  { total, hasMore }: { total: number; hasMore: boolean }
): PopoverPage<T> {
  const visible = loaded.slice(0, POPOVER_CAP);
  const room = POPOVER_CAP - visible.length;
  return {
    visible,
    nextPageSize:
      hasMore && room > 0 ? Math.min(POPOVER_PAGE_SIZE, room) : null,
    capNote:
      room === 0 && total > POPOVER_CAP
        ? `Showing the latest ${POPOVER_CAP} of ${total}`
        : null,
  };
}

export type FeedBody =
  | { kind: "loading" }
  | { kind: "rows" }
  | { kind: "empty"; title: string; detail: string }
  | { kind: "error"; title: string; detail: string };

/** How the Feed's first fetch went: still waiting, back, or failed. */
export type FeedLoad = "pending" | "loaded" | "failed";

/**
 * Picks what the Feed's body shows. Skeleton rows until the first fetch has
 * come back, so the empty state never flashes up before the Notifications,
 * and an error rather than the empty state when the fetch failed.
 */
export function feedBody({
  load,
  count,
  unreadOnly,
}: {
  load: FeedLoad;
  count: number;
  unreadOnly: boolean;
}): FeedBody {
  if (count > 0) return { kind: "rows" };
  if (load === "pending") return { kind: "loading" };
  if (load === "failed") {
    return {
      kind: "error",
      title: "Couldn't load Notifications.",
      detail: "Try again in a moment.",
    };
  }
  return unreadOnly
    ? {
        kind: "empty",
        title: "You're all caught up",
        detail: "Nothing unread here.",
      }
    : {
        kind: "empty",
        title: "No Notifications yet",
        detail:
          "When something concerns you, such as a reply or a refund update, it'll show up here.",
      };
}

/** Where the "Powered by Knock" footer links, as Knock asks. */
export const KNOCK_BRANDING_URL =
  "https://knock.app?utm_source=powered-by-knock&utm_medium=referral&utm_campaign=knock-branding-feed";

/**
 * Whether the "Powered by Knock" footer shows: whenever Knock's Feed settings
 * say branding is required, except while skeleton rows show. It goes away on
 * its own if the plan stops requiring it.
 */
export function showsKnockBranding(
  settings: { features: { branding_required: boolean } } | null,
  body: FeedBody
): boolean {
  return body.kind !== "loading" && settings?.features.branding_required === true;
}
