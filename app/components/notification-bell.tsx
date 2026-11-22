import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  KnockFeedProvider,
  KnockProvider,
  useKnockFeed,
} from "@knocklabs/react";
import type { FeedItem } from "@knocklabs/client";
import { Bell, BellOff } from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import {
  describeNotification,
  type KnockFeedSession,
} from "~/lib/notifications";

// ─── Notification Feed: the bell and its popover ───
// Built from Knock's feed hooks, not its stock components, so it looks like
// Cadence. With no Knock session (no keys configured, or signed out) the bell
// still renders and the popover shows the empty Feed.

/**
 * Connects the page to the person's Knock Feed. Without a session it renders
 * its children unchanged.
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
      <KnockFeedProvider feedId={session.feedChannelId}>
        {children}
      </KnockFeedProvider>
    </KnockProvider>
  );
}

export function NotificationBell({ live }: { live: boolean }) {
  return live ? (
    <LiveBell />
  ) : (
    <BellPopover unreadCount={0} body={<EmptyFeed />} />
  );
}

function LiveBell() {
  const { feedClient, useFeedStore } = useKnockFeed();
  const items = useFeedStore((state) => state.items);
  // Unread, not unseen: the count stays until a Notification is read.
  const unreadCount = useFeedStore((state) => state.metadata.unread_count);
  const [fetched, setFetched] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    feedClient
      .fetch()
      .catch((error: unknown) =>
        console.error("Could not load the Feed", error)
      )
      .finally(() => {
        if (!cancelled) setFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [feedClient]);

  return (
    <BellPopover
      unreadCount={unreadCount}
      body={(close) =>
        !fetched && items.length === 0 ? (
          <FeedSkeleton />
        ) : items.length === 0 ? (
          <EmptyFeed />
        ) : (
          <ul className="flex-1 overflow-y-auto">
            {items.map((item) => (
              <FeedRow
                key={item.id}
                item={item}
                onOpen={(href) => {
                  void feedClient.markAsRead(item);
                  close();
                  if (href) void navigate(href);
                }}
              />
            ))}
          </ul>
        )
      }
    />
  );
}

function BellPopover({
  unreadCount,
  body,
}: {
  unreadCount: number;
  body: React.ReactNode | ((close: () => void) => React.ReactNode);
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

  return (
    <>
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
          className="fixed left-[calc(14rem+8px)] top-2 z-40 flex max-h-[min(640px,calc(100vh-1rem))] w-[400px] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
        >
          <header className="border-b px-4 py-3">
            <h2 className="text-base font-semibold">Notifications</h2>
          </header>
          {typeof body === "function" ? body(close) : body}
        </div>
      )}
    </>
  );
}

function FeedRow({
  item,
  onOpen,
}: {
  item: FeedItem;
  onOpen: (href: string | null) => void;
}) {
  const described = describeNotification(item.source.key, item.data);
  const unread = item.read_at === null;

  return (
    <li className="border-b last:border-0">
      <button
        type="button"
        onClick={() => onOpen(described?.href ?? null)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60",
          unread && "bg-primary/[0.04]"
        )}
      >
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
            {formatRelativeTime(item.inserted_at)}
          </span>
        </span>
        {unread && (
          <span
            aria-label="Unread"
            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
          />
        )}
      </button>
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2">
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyFeed() {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <div className="mb-3 rounded-full bg-muted p-3">
        <BellOff className="size-6 text-muted-foreground" />
      </div>
      <p className="font-medium">No Notifications yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        When something concerns you, such as a Reply to your Comment, it'll show
        up here.
      </p>
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
