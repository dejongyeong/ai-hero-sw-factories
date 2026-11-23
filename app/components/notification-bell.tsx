import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  KnockFeedProvider,
  KnockProvider,
  useFeedSettings,
  useKnockFeed,
} from "@knocklabs/react";
import type { FeedItem } from "@knocklabs/client";
import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  CircleX,
  MessageCircleQuestion,
  MessageSquareReply,
  ReceiptText,
  Undo2,
} from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import {
  describeNotification,
  isNotificationWorkflow,
  liveNewQuestion,
  newQuestionCommentIds,
  NotificationWorkflow,
  type DescribedNotification,
  type KnockFeedSession,
} from "~/lib/notifications";
import {
  feedBody,
  groupByDay,
  KNOCK_BRANDING_URL,
  POPOVER_PAGE_SIZE,
  popoverPage,
  showsKnockBranding,
  type FeedBody,
  type FeedLoad,
  type PopoverPage,
} from "~/lib/notification-feed";

// ─── Notification Feed: the bell and its popover ───
// Built from Knock's feed hooks, not its stock components, so it matches
// Cadence's own UI. With no Knock session (no keys configured, or signed out)
// the bell still renders and the popover shows the empty Feed.

/**
 * Connects the page to the person's Knock Feed. Without a session it renders
 * its children unchanged. The bell's count and the popover share this one
 * feed store, so marking a row read updates the count straight away.
 */
export function NotificationFeedProvider({
  session,
  children,
}: {
  session: KnockFeedSession | null;
  children: React.ReactNode;
}) {
  if (!session) return <>{children}</>;
  return (
    <KnockProvider
      apiKey={session.publicKey}
      user={{ id: session.userId }}
      userToken={session.userToken}
    >
      {/* Rich mode, not the client's default compact one, so a batched item
          carries total_activities and each Question's own activity. */}
      <KnockFeedProvider
        feedId={session.feedChannelId}
        defaultFeedOptions={{ page_size: POPOVER_PAGE_SIZE, mode: "rich" }}
      >
        {children}
      </KnockFeedProvider>
    </KnockProvider>
  );
}

export function NotificationBell({ live }: { live: boolean }) {
  return live ? (
    <LiveBell />
  ) : (
    <BellPopover unreadCount={0}>
      {(close) => (
        <PopoverPanel
          unreadCount={0}
          onMarkAllRead={null}
          onClose={close}
          branding={false}
        >
          {/* No live Feed, so never any rows. */}
          <FeedBodyView
            body={feedBody({ load: "loaded", count: 0, unreadOnly: false })}
            renderRows={() => null}
          />
        </PopoverPanel>
      )}
    </BellPopover>
  );
}

function LiveBell() {
  const { feedClient, useFeedStore } = useKnockFeed();
  // Unread, not unseen: the count stays until a Notification is read. It is
  // Knock's count, so it can include an unread New question the popover hides
  // because every Question in it is deleted (see liveNewQuestion): one whose
  // last Question went just after the batch window closed, too late to cancel
  // and before the message existed to archive. An accepted caveat, not fixed.
  const unreadCount = useFeedStore((state) => state.metadata.unread_count);
  const [load, setLoad] = useState<FeedLoad>("pending");
  // Fetched once here, not on every open, so the footer doesn't pop in late.
  const { settings } = useFeedSettings(feedClient);

  useEffect(() => {
    let cancelled = false;
    // Knock reports a failed fetch as { status: "error" } rather than throwing.
    feedClient.fetch().then(
      (result) => {
        if (result?.status !== "ok") {
          console.error("Could not load the Feed", result?.data);
        }
        if (!cancelled) setLoad(result?.status === "ok" ? "loaded" : "failed");
      },
      (error: unknown) => {
        console.error("Could not load the Feed", error);
        if (!cancelled) setLoad("failed");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [feedClient]);

  return (
    <BellPopover unreadCount={unreadCount}>
      {(close) => (
        <LivePanel load={load} settings={settings} onClose={close} />
      )}
    </BellPopover>
  );
}

type FeedSettings = ReturnType<typeof useFeedSettings>["settings"];

function LivePanel({
  load,
  settings,
  onClose,
}: {
  load: FeedLoad;
  settings: FeedSettings;
  onClose: () => void;
}) {
  const { feedClient, useFeedStore } = useKnockFeed();
  const items = useFeedStore((state) => state.items);
  const metadata = useFeedStore((state) => state.metadata);
  const hasMore = useFeedStore((state) => Boolean(state.pageInfo.after));
  const networkStatus = useFeedStore((state) => state.networkStatus);
  const navigate = useNavigate();
  const liveness = useLiveQuestions(items);

  // Each row's sentence and link. A New question is counted without its
  // deleted Questions; one with none live is hidden, and one whose Questions
  // are still being checked is held back rather than shown with a wrong count.
  const rows = new Map<string, DescribedNotification | null>();
  let checking = false;
  for (const item of items) {
    const row = describeRow(item, liveness);
    if (row === "checking") checking = true;
    else if (row !== "hidden") rows.set(item.id, row);
  }
  const shown = items.filter((item) => rows.has(item.id));

  // Skeleton rows until the first liveness check is back, so the first view
  // is never a count that is about to change. Later pages hold back only
  // their own unchecked rows.
  const [settled, setSettled] = useState(false);
  if (!settled && load !== "pending" && !checking) setSettled(true);

  // The Unread filter arrives with the filter chips; until then it's off.
  const body = feedBody({
    load: !settled && load === "loaded" ? "pending" : load,
    count: settled ? shown.length : 0,
    unreadOnly: false,
  });

  const markAllRead = () => {
    feedClient
      .markAllAsRead()
      .catch((error: unknown) =>
        console.error("Could not mark all Notifications read", error)
      );
  };

  const markRead = (item: FeedItem) => {
    feedClient
      .markAsRead(item)
      .catch((error: unknown) =>
        console.error("Could not mark the Notification read", error)
      );
  };

  return (
    <PopoverPanel
      unreadCount={metadata.unread_count}
      onMarkAllRead={markAllRead}
      onClose={onClose}
      branding={showsKnockBranding(settings, body)}
    >
      <FeedBodyView
        body={body}
        renderRows={() => (
          <FeedRows
            page={popoverPage(shown, { total: metadata.total_count, hasMore })}
            describe={(item) => rows.get(item.id) ?? null}
            canFetch={networkStatus === "ready"}
            loadingMore={networkStatus === "fetchMore"}
            onLoadMore={(pageSize) => {
              void feedClient.fetchNextPage({ page_size: pageSize });
            }}
            onOpen={(item, href) => {
              markRead(item);
              onClose();
              if (href) void navigate(href);
            }}
            onMarkRead={markRead}
          />
        )}
      />
    </PopoverPanel>
  );
}

/**
 * What the app has said about the Questions in the Feed's New question rows:
 * whether each is live, and which couldn't be checked.
 */
type QuestionLiveness = {
  live: ReadonlyMap<number, boolean>;
  failed: ReadonlySet<number>;
};

/**
 * Asks the app which Questions in the loaded New question rows are still
 * live, as rows load. It lives in the popover, so every open checks afresh
 * and picks up Questions deleted since. A failed check leaves those Questions
 * to Knock's count.
 */
function useLiveQuestions(items: FeedItem[]): QuestionLiveness {
  const [live, setLive] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());

  const unchecked = new Set<number>();
  for (const item of items) {
    if (item.source.key !== NotificationWorkflow.NewQuestion) continue;
    for (const id of newQuestionCommentIds(item)) {
      if (!live.has(id) && !failed.has(id)) unchecked.add(id);
    }
  }
  // A stable key, so the effect runs once per new set of ids.
  const key = [...unchecked].sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!key) return;
    const commentIds = key.split(",").map(Number);
    let cancelled = false;
    fetch("/api/live-comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentIds }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { liveIds } = (await response.json()) as { liveIds: number[] };
        if (cancelled) return;
        const liveSet = new Set(liveIds);
        setLive((previous) => {
          const next = new Map(previous);
          for (const id of commentIds) next.set(id, liveSet.has(id));
          return next;
        });
      })
      .catch((error: unknown) => {
        console.error("Could not check which Questions are live", error);
        if (!cancelled) {
          setFailed((previous) => new Set([...previous, ...commentIds]));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { live, failed };
}

/**
 * A row's sentence and link, "hidden" for a New question with no Question
 * live, or "checking" while its Questions' liveness is still on its way.
 */
function describeRow(
  item: FeedItem,
  { live, failed }: QuestionLiveness
): DescribedNotification | null | "hidden" | "checking" {
  if (item.source.key !== NotificationWorkflow.NewQuestion) {
    return describeNotification(item.source.key, item.data);
  }
  const ids = newQuestionCommentIds(item);
  let liveIds: Set<number> | null = new Set();
  for (const id of ids) {
    if (failed.has(id)) {
      liveIds = null;
      break;
    }
    const isLive = live.get(id);
    if (isLive === undefined) return "checking";
    if (isLive) liveIds.add(id);
  }
  const counted = liveNewQuestion(item, liveIds);
  if (!counted) return "hidden";
  return describeNotification(item.source.key, counted.data, counted.count);
}

/** The popover's header and pinned footer around whatever body it shows. */
function PopoverPanel({
  unreadCount,
  onMarkAllRead,
  onClose,
  branding,
  children,
}: {
  unreadCount: number;
  /** Null when there's no live Feed to mark. */
  onMarkAllRead: (() => void) | null;
  onClose: () => void;
  branding: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <PopoverHeader unreadCount={unreadCount} onMarkAllRead={onMarkAllRead} />
      {children}
      <PopoverFooter onClose={onClose} branding={branding} />
    </>
  );
}

function BellPopover({
  unreadCount,
  children,
}: {
  unreadCount: number;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !panelRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  // Anchored to the bell: the popover opens beside it, clear of the sidebar.
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={open}
        className={cn(
          "relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          open && "bg-sidebar-accent text-sidebar-accent-foreground"
        )}
      >
        <Bell className="size-[18px]" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-sidebar">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="absolute left-full top-0 z-40 ml-6 flex max-h-[min(640px,calc(100vh-2rem))] w-[420px] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

function PopoverHeader({
  unreadCount,
  onMarkAllRead,
}: {
  unreadCount: number;
  /** Null when there's no live Feed to mark. */
  onMarkAllRead: (() => void) | null;
}) {
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <h2 className="text-base font-semibold">Notifications</h2>
      <button
        type="button"
        title="Mark all as read"
        disabled={!onMarkAllRead || unreadCount === 0}
        onClick={() => onMarkAllRead?.()}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <CheckCheck className="size-4" /> Mark all read
      </button>
    </header>
  );
}

function PopoverFooter({
  onClose,
  branding,
}: {
  onClose: () => void;
  branding: boolean;
}) {
  return (
    <footer className="border-t">
      {/* Pinned: always reachable, whatever the scroll position. */}
      <Link
        to="/notifications"
        onClick={onClose}
        className="flex items-center justify-center gap-1 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted/60"
      >
        View all notifications
        <ChevronRight className="size-4" />
      </Link>
      {branding && (
        <a
          href={KNOCK_BRANDING_URL}
          target="_blank"
          rel="noreferrer"
          className="block pb-2 text-center text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        >
          Powered by Knock
        </a>
      )}
    </footer>
  );
}

/** The popover's body: rows, skeleton rows, an empty state or an error. */
function FeedBodyView({
  body,
  renderRows,
}: {
  body: FeedBody;
  renderRows: () => React.ReactNode;
}) {
  switch (body.kind) {
    case "rows":
      return renderRows();
    case "loading":
      return <FeedSkeleton />;
    case "empty":
      return <FeedMessage icon={BellOff} {...body} />;
    case "error":
      return <FeedMessage icon={AlertCircle} {...body} />;
  }
}

function FeedMessage({
  icon: Icon,
  title,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <div className="mb-3 rounded-full bg-muted p-3">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Rows grouped under sticky Today / Yesterday / Earlier headers, loaded on scroll. */
function FeedRows({
  page,
  describe,
  canFetch,
  loadingMore,
  onLoadMore,
  onOpen,
  onMarkRead,
}: {
  page: PopoverPage<FeedItem>;
  describe: (item: FeedItem) => DescribedNotification | null;
  canFetch: boolean;
  loadingMore: boolean;
  onLoadMore: (pageSize: number) => void;
  onOpen: (item: FeedItem, href: string | null) => void;
  onMarkRead: (item: FeedItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const { visible: items, nextPageSize, capNote } = page;

  // Load the next page as the bottom scrolls into view, up to the cap.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextPageSize === null || !canFetch) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMoreRef.current(nextPageSize);
      },
      { root: scrollRef.current, rootMargin: "120px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [nextPageSize, canFetch, items.length]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {groupByDay(items, new Date()).map((group) => (
        <section key={group.label}>
          <h3 className="sticky top-0 z-10 border-b bg-popover/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
            {group.label}
          </h3>
          <ul>
            {group.items.map((item) => (
              <FeedRow
                key={item.id}
                item={item}
                described={describe(item)}
                onOpen={onOpen}
                onMarkRead={onMarkRead}
              />
            ))}
          </ul>
        </section>
      ))}
      <div
        ref={sentinelRef}
        className="px-4 py-3 text-center text-xs text-muted-foreground empty:py-1"
      >
        {capNote ?? (loadingMore ? "Loading more…" : null)}
      </div>
    </div>
  );
}

type RowIcon = { icon: React.ReactNode; tone: string };

// Every workflow needs an icon: adding one to NotificationWorkflow fails the
// type check here until it has one.
const ROW_ICONS = {
  [NotificationWorkflow.CommentReply]: {
    icon: <MessageSquareReply className="size-4" />,
    tone: "bg-sky-100 text-sky-600 dark:bg-sky-950",
  },
  [NotificationWorkflow.NewQuestion]: {
    icon: <MessageCircleQuestion className="size-4" />,
    tone: "bg-violet-100 text-violet-600 dark:bg-violet-950",
  },
  [NotificationWorkflow.RefundRequestRaised]: {
    icon: <Undo2 className="size-4" />,
    tone: "bg-amber-100 text-amber-600 dark:bg-amber-950",
  },
  [NotificationWorkflow.RefundRequestReceived]: {
    icon: <ReceiptText className="size-4" />,
    tone: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950",
  },
  [NotificationWorkflow.RefundRequestApproved]: {
    icon: <CircleCheck className="size-4" />,
    tone: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950",
  },
  [NotificationWorkflow.RefundRequestDeclined]: {
    icon: <CircleX className="size-4" />,
    tone: "bg-rose-100 text-rose-600 dark:bg-rose-950",
  },
} satisfies Record<NotificationWorkflow, RowIcon>;

const FALLBACK_ICON: RowIcon = {
  icon: <Bell className="size-4" />,
  tone: "bg-muted text-muted-foreground",
};

function FeedRow({
  item,
  described,
  onOpen,
  onMarkRead,
}: {
  item: FeedItem;
  described: DescribedNotification | null;
  onOpen: (item: FeedItem, href: string | null) => void;
  onMarkRead: (item: FeedItem) => void;
}) {
  const { icon, tone } = isNotificationWorkflow(item.source.key)
    ? ROW_ICONS[item.source.key]
    : FALLBACK_ICON;
  const unread = item.read_at === null;

  return (
    <li className="group relative border-b last:border-0">
      <button
        type="button"
        onClick={() => onOpen(item, described?.href ?? null)}
        className={cn(
          "flex w-full gap-3 px-4 py-3 pr-10 text-left transition-colors hover:bg-muted/60",
          unread && "bg-primary/[0.04]"
        )}
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            tone
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm leading-snug",
              unread ? "text-foreground/80" : "text-muted-foreground"
            )}
          >
            {described
              ? described.sentence.map((part, index) =>
                  part.bold ? (
                    <strong
                      key={index}
                      className="font-semibold text-foreground"
                    >
                      {part.text}
                    </strong>
                  ) : (
                    <span key={index}>{part.text}</span>
                  )
                )
              : "You have a new Notification"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground/80">
            {described ? `${described.category} · ` : ""}
            {formatRelativeTime(item.inserted_at)}
          </span>
        </span>
      </button>
      {unread && (
        // The unread dot; on hover it becomes a check mark that marks it read.
        <button
          type="button"
          title="Mark as read"
          aria-label="Mark as read"
          onClick={() => onMarkRead(item)}
          className="absolute right-3 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full hover:bg-muted"
        >
          <span className="size-2 rounded-full bg-primary group-hover:hidden" />
          <Check className="hidden size-3.5 text-muted-foreground group-hover:block" />
        </button>
      )}
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-label="Loading Notifications">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex gap-3">
          <div className="size-9 animate-pulse rounded-lg bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * When the URL has a hash, scrolls to that element and briefly highlights it,
 * so a Notification lands on the exact record. Waits a little for the record
 * to render.
 */
export function HighlightAnchor() {
  const location = useLocation();

  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;

    const classes = ["ring-2", "ring-primary", "bg-primary/10", "rounded-md"];
    const started = Date.now();
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let highlighted: HTMLElement | null = null;

    const tick = () => {
      const element = document.getElementById(id);
      if (!element) {
        if (Date.now() - started < 3000) frame = requestAnimationFrame(tick);
        return;
      }
      highlighted = element;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add("transition-all", ...classes);
      timer = setTimeout(() => element.classList.remove(...classes), 2500);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      highlighted?.classList.remove(...classes);
    };
  }, [location.key, location.hash]);

  return null;
}
