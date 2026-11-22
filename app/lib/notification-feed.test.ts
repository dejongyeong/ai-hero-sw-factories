import { describe, expect, it } from "vitest";
import {
  feedBody,
  groupByDay,
  popoverPage,
  showsKnockBranding,
} from "./notification-feed";

// Local times, so the day boundaries are the person's own days.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
const now = new Date(2026, 10, 22, 9, 30);

describe("groupByDay", () => {
  it("groups newest-first Notifications under Today, Yesterday and Earlier", () => {
    const items = [
      { id: "a", inserted_at: at(22, 9, 0) },
      { id: "b", inserted_at: at(22, 0, 5) },
      { id: "c", inserted_at: at(21, 23, 59) },
      { id: "d", inserted_at: at(21, 0, 0) },
      { id: "e", inserted_at: at(20, 23, 59) },
      { id: "f", inserted_at: at(2, 12, 0) },
    ];

    expect(
      groupByDay(items, now).map((group) => ({
        label: group.label,
        ids: group.items.map((item) => item.id),
      }))
    ).toEqual([
      { label: "Today", ids: ["a", "b"] },
      { label: "Yesterday", ids: ["c", "d"] },
      { label: "Earlier", ids: ["e", "f"] },
    ]);
  });
});

describe("popoverPage", () => {
  const feed = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `n${index}` }));

  it("loads the first 20, then asks for 20 more while more exist", () => {
    expect(popoverPage(feed(20), { total: 120, hasMore: true })).toEqual({
      visible: feed(20),
      nextPageSize: 20,
      capNote: null,
    });
  });

  it("asks only for what's left to reach 50", () => {
    expect(
      popoverPage(feed(40), { total: 120, hasMore: true }).nextPageSize
    ).toBe(10);
  });

  it("stops at 50 and says how many there are in all", () => {
    expect(popoverPage(feed(50), { total: 120, hasMore: true })).toEqual({
      visible: feed(50),
      nextPageSize: null,
      capNote: "Showing the latest 50 of 120",
    });
  });

  it("never shows more than 50, even if more were loaded", () => {
    const page = popoverPage(feed(60), { total: 120, hasMore: true });
    expect(page.visible).toHaveLength(50);
    expect(page.capNote).toBe("Showing the latest 50 of 120");
  });

  it("says nothing extra when everything fits", () => {
    expect(popoverPage(feed(7), { total: 7, hasMore: false })).toEqual({
      visible: feed(7),
      nextPageSize: null,
      capNote: null,
    });
  });

  it("has no cap note at exactly 50", () => {
    expect(
      popoverPage(feed(50), { total: 50, hasMore: false }).capNote
    ).toBeNull();
  });
});

describe("feedBody", () => {
  it("shows skeleton rows until the first fetch finishes, never the empty state", () => {
    expect(feedBody({ load: "pending", count: 0, unreadOnly: false })).toEqual({
      kind: "loading",
    });
  });

  it("shows rows as soon as there are any, even mid-fetch", () => {
    expect(feedBody({ load: "pending", count: 3, unreadOnly: false })).toEqual({
      kind: "rows",
    });
  });

  it("says there are no Notifications yet once a fetch comes back empty", () => {
    expect(feedBody({ load: "loaded", count: 0, unreadOnly: false })).toEqual({
      kind: "empty",
      title: "No Notifications yet",
      detail:
        "When something concerns you, such as a reply or a refund update, it'll show up here.",
    });
  });

  it("says the Feed couldn't load when the fetch fails, never that it's empty", () => {
    expect(feedBody({ load: "failed", count: 0, unreadOnly: false })).toEqual({
      kind: "error",
      title: "Couldn't load Notifications.",
      detail: "Try again in a moment.",
    });
  });

  it("keeps showing rows already loaded if a later fetch fails", () => {
    expect(feedBody({ load: "failed", count: 3, unreadOnly: false })).toEqual({
      kind: "rows",
    });
  });

  it("says you're all caught up when the Unread filter finds nothing", () => {
    expect(feedBody({ load: "loaded", count: 0, unreadOnly: true })).toEqual({
      kind: "empty",
      title: "You're all caught up",
      detail: "Nothing unread here.",
    });
  });
});

describe("showsKnockBranding", () => {
  const required = { features: { branding_required: true } };
  const notRequired = { features: { branding_required: false } };

  it("shows the footer when Knock says branding is required", () => {
    expect(showsKnockBranding(required, { kind: "rows" })).toBe(true);
    expect(
      showsKnockBranding(required, {
        kind: "empty",
        title: "No Notifications yet",
        detail: "",
      })
    ).toBe(true);
  });

  it("hides the footer when branding isn't required", () => {
    expect(showsKnockBranding(notRequired, { kind: "rows" })).toBe(false);
  });

  it("hides the footer before the settings have loaded", () => {
    expect(showsKnockBranding(null, { kind: "rows" })).toBe(false);
  });

  it("hides the footer while skeleton rows show", () => {
    expect(showsKnockBranding(required, { kind: "loading" })).toBe(false);
  });
});
