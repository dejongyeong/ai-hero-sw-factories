// PROTOTYPE — throwaway. Lives only on the `prototype/notification-feed` branch; never merge.
// "What the Notification Feed looks like" (dejongyeong/ai-hero-sw-factories#8):
// three structurally different Feeds, switchable via ?variant= and the bottom bar.
//   A  Knock stock — bell + count badge in the sidebar header, Knock's own popover and cells.
//   B  Feed page   — "Notifications" sidebar item with count pill → full /notifications page.
//   C  Drawer      — bell with a dot in the user row → right-hand slide-over, Cadence-styled cards.
//   D  Cadence popover — A's placement and badge, Cadence's own design, no Knock branding,
//      category filters, infinite scroll, deep links that land on the exact record.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  KnockFeedProvider,
  KnockProvider,
  NotificationFeedPopover,
  NotificationIconButton,
  useKnockFeed,
} from "@knocklabs/react";
import type { FeedItem } from "@knocklabs/client";
import "@knocklabs/react/dist/index.css";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Inbox,
  MessageSquare,
  MessageSquareReply,
  ReceiptText,
  ShoppingBag,
  UserPlus,
  Wallet,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";

export const VARIANTS = {
  A: "Knock stock popover",
  B: "Sidebar item + Feed page",
  C: "Bell + slide-over drawer",
  D: "Cadence popover (A, redesigned)",
} as const;
export type Variant = keyof typeof VARIANTS;
const KEYS = Object.keys(VARIANTS) as Variant[];

// ---------- variant state (URL param, remembered across in-app navigation) ----------

const VariantContext = createContext<Variant>("A");
export const useVariant = () => useContext(VariantContext);

function useVariantState(): Variant {
  const [params] = useSearchParams();
  const fromUrl = params.get("variant") as Variant | null;
  const [stored, setStored] = useState<Variant | null>(null);
  useEffect(() => {
    if (fromUrl && KEYS.includes(fromUrl)) {
      try {
        sessionStorage.setItem("prototype-feed-variant", fromUrl);
      } catch {}
      setStored(fromUrl);
    } else {
      try {
        const s = sessionStorage.getItem("prototype-feed-variant") as Variant | null;
        if (s && KEYS.includes(s)) setStored(s);
      } catch {}
    }
  }, [fromUrl]);
  return (fromUrl && KEYS.includes(fromUrl) ? fromUrl : stored) ?? "A";
}

// ---------- providers ----------

export type KnockSession = {
  knockId: string;
  userToken: string;
  publicKey: string;
  feedId: string;
  categories: string[];
};

const SessionContext = createContext<KnockSession | null>(null);

export function PrototypeFeedProvider({
  session,
  children,
}: {
  session: KnockSession | null;
  children: React.ReactNode;
}) {
  const variant = useVariantState();
  if (!session) {
    return <VariantContext.Provider value={variant}>{children}</VariantContext.Provider>;
  }
  return (
    <VariantContext.Provider value={variant}>
      <SessionContext.Provider value={session}>
      <KnockProvider
        apiKey={session.publicKey}
        user={{ id: session.knockId }}
        userToken={session.userToken}
      >
        <KnockFeedProvider feedId={session.feedId}>
          <FetchOnMount />
          {children}
        </KnockFeedProvider>
      </KnockProvider>
      </SessionContext.Provider>
    </VariantContext.Provider>
  );
}

function FetchOnMount() {
  const { feedClient } = useKnockFeed();
  useEffect(() => {
    feedClient.fetch();
  }, [feedClient]);
  return null;
}

function useFeed() {
  const { feedClient, useFeedStore } = useKnockFeed();
  const items = useFeedStore((s) => s.items);
  const metadata = useFeedStore((s) => s.metadata);
  const loading = useFeedStore((s) => s.loading);
  return { feedClient, items, metadata, loading };
}

// ---------- shared rendering ----------

type NotificationData = {
  kind: string;
  message: string;
  actor: string | null;
  course: string;
  url: string;
};
const dataOf = (item: FeedItem) => (item.data ?? {}) as Partial<NotificationData>;

const KIND: Record<string, { icon: React.ReactNode; tone: string; label: string }> = {
  "comment-reply": { icon: <MessageSquareReply className="size-4" />, tone: "text-sky-600 bg-sky-100 dark:bg-sky-950", label: "Comment reply" },
  "new-question": { icon: <MessageSquare className="size-4" />, tone: "text-sky-600 bg-sky-100 dark:bg-sky-950", label: "New question" },
  "refund-raised": { icon: <ReceiptText className="size-4" />, tone: "text-amber-600 bg-amber-100 dark:bg-amber-950", label: "Refund Request raised" },
  "refund-received": { icon: <ReceiptText className="size-4" />, tone: "text-slate-600 bg-slate-100 dark:bg-slate-800", label: "Refund Request received" },
  "refund-approved": { icon: <CircleCheck className="size-4" />, tone: "text-emerald-600 bg-emerald-100 dark:bg-emerald-950", label: "Refund Request approved" },
  "refund-declined": { icon: <CircleX className="size-4" />, tone: "text-rose-600 bg-rose-100 dark:bg-rose-950", label: "Refund Request declined" },
  "refund-issued": { icon: <Wallet className="size-4" />, tone: "text-emerald-600 bg-emerald-100 dark:bg-emerald-950", label: "Refund Issued" },
  "refund-failed": { icon: <CircleAlert className="size-4" />, tone: "text-rose-600 bg-rose-100 dark:bg-rose-950", label: "Refund Failed" },
  "new-purchase": { icon: <ShoppingBag className="size-4" />, tone: "text-violet-600 bg-violet-100 dark:bg-violet-950", label: "New Purchase" },
  "seat-claimed": { icon: <UserPlus className="size-4" />, tone: "text-violet-600 bg-violet-100 dark:bg-violet-950", label: "Seat Claimed" },
};
const kindOf = (k?: string) =>
  KIND[k ?? ""] ?? { icon: <Bell className="size-4" />, tone: "text-muted-foreground bg-muted", label: "Notification" };

/** Renders the catalogue's **bold** markdown without a markdown dependency. */
function Message({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** After navigating to `/path#anchor`, scroll to the record and flash it. */
function highlightHash(url: string) {
  const id = url.split("#")[1];
  if (!id) return;
  const started = Date.now();
  const tick = () => {
    const el = document.getElementById(id);
    if (!el) {
      if (Date.now() - started < 3000) requestAnimationFrame(tick);
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const cls = ["ring-2", "ring-primary", "bg-primary/10", "rounded-md", "transition-all"];
    el.classList.add(...cls);
    setTimeout(() => el.classList.remove(...cls), 2500);
  };
  tick();
}

function useOpenNotification(onDone?: () => void) {
  const { feedClient } = useKnockFeed();
  const navigate = useNavigate();
  return async (item: FeedItem) => {
    feedClient.markAsRead(item);
    onDone?.();
    const url = dataOf(item).url;
    if (url) {
      await navigate(url);
      highlightHash(url);
    }
  };
}

// ---------- Variant A: Knock stock ----------

export function VariantABell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  return (
    <>
      <NotificationIconButton ref={ref} onClick={() => setOpen(!open)} />
      <NotificationFeedPopover
        buttonRef={ref}
        isVisible={open}
        onClose={() => setOpen(false)}
        placement="right-start"
        onNotificationClick={(item) => {
          setOpen(false);
          const url = dataOf(item).url;
          if (url) navigate(url);
        }}
      />
    </>
  );
}

// ---------- Variant B: sidebar item + page ----------

export function VariantBNavItem() {
  const { metadata } = useFeed();
  const { pathname } = useLocation();
  const active = pathname === "/notifications";
  return (
    <Link
      to="/notifications"
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Bell className="size-4" />
      Notifications
      {metadata.unread_count > 0 && (
        <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
          {metadata.unread_count > 99 ? "99+" : metadata.unread_count}
        </span>
      )}
    </Link>
  );
}

function dayBucket(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return "Earlier";
}

export function VariantBPage() {
  const { feedClient, items, metadata, loading } = useFeed();
  const [tab, setTab] = useState<"unread" | "all">("all");
  const openItem = useOpenNotification();
  // The Feed is client-fetched: without this the server renders the empty state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const shown = tab === "unread" ? items.filter((i) => !i.read_at) : items;
  const groups = shown.reduce<Record<string, FeedItem[]>>((acc, i) => {
    (acc[dayBucket(i.inserted_at)] ??= []).push(i);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-muted-foreground">
            {metadata.unread_count > 0
              ? `${metadata.unread_count} unread`
              : "You're all caught up"}
          </p>
        </div>
        <button
          disabled={metadata.unread_count === 0}
          onClick={() => feedClient.markAllAsRead()}
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-40"
        >
          <CheckCheck className="size-4" /> Mark all as read
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {(["all", "unread"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {(!mounted || loading) && items.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-center">
          <div className="mb-4 rounded-full bg-muted p-4">
            <BellOff className="size-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold">
            {tab === "unread" ? "No unread Notifications" : "No Notifications yet"}
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Replies to your comments, refund updates and other things that
            concern you will show up here.
          </p>
        </div>
      ) : (
        Object.entries(groups).map(([day, list]) => (
          <section key={day} className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {day}
            </h2>
            <ul className="divide-y rounded-lg border">
              {list.map((item) => {
                const d = dataOf(item);
                const k = kindOf(d.kind);
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => openItem(item)}
                      className={cn(
                        "flex w-full items-start gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                        !item.read_at && "bg-primary/5"
                      )}
                    >
                      <span className={cn("mt-0.5 rounded-md p-2", k.tone)}>{k.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-muted-foreground">
                          <Message text={d.message ?? ""} />
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground/70">
                          {k.label} · {ago(item.inserted_at)}
                        </span>
                      </span>
                      {!item.read_at && (
                        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// ---------- Variant C: bell + drawer ----------

export function VariantCBell() {
  const { feedClient, items, metadata } = useFeed();
  const [open, setOpen] = useState(false);
  const openItem = useOpenNotification(() => setOpen(false));

  useEffect(() => {
    if (open && metadata.unseen_count > 0) feedClient.markAllAsSeen();
  }, [open, metadata.unseen_count, feedClient]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Notifications"
        className="relative rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {metadata.unseen_count > 0 && (
          <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-rose-500 ring-2 ring-sidebar" />
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <aside
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 flex h-full w-[400px] max-w-full flex-col border-l bg-background shadow-xl"
          >
            <header className="flex h-14 items-center justify-between border-b px-4">
              <h2 className="font-semibold">Notifications</h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => feedClient.markAllAsRead()}
                  disabled={metadata.unread_count === 0}
                  className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  Mark all read
                </button>
                <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-muted">
                  <X className="size-4" />
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-3">
              {items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <Inbox className="mb-3 size-10 text-muted-foreground/50" />
                  <p className="font-medium">Nothing new</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    We'll let you know when something concerns you.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {items.map((item) => {
                    const d = dataOf(item);
                    const k = kindOf(d.kind);
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "group relative rounded-lg border p-3 transition-colors hover:border-primary/40",
                          item.read_at ? "bg-background" : "border-l-4 border-l-primary bg-card"
                        )}
                      >
                        <button onClick={() => openItem(item)} className="flex w-full gap-3 text-left">
                          <span className="relative shrink-0">
                            {d.actor ? (
                              <UserAvatar name={d.actor} avatarUrl={null} />
                            ) : (
                              <span className={cn("flex size-8 items-center justify-center rounded-full", k.tone)}>
                                {k.icon}
                              </span>
                            )}
                            {d.actor && (
                              <span className={cn("absolute -bottom-1 -right-1 rounded-full p-0.5 ring-2 ring-background [&>svg]:size-3", k.tone)}>
                                {k.icon}
                              </span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1 pr-12">
                            <span className="block text-sm leading-snug text-muted-foreground">
                              <Message text={d.message ?? ""} />
                            </span>
                            <span className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground/70">
                              <span className="truncate rounded bg-muted px-1.5 py-0.5">{d.course}</span>
                              {ago(item.inserted_at)}
                            </span>
                          </span>
                        </button>
                        <span className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                          {!item.read_at && (
                            <button
                              title="Mark as read"
                              onClick={() => feedClient.markAsRead(item)}
                              className="rounded p-1 text-muted-foreground hover:bg-muted"
                            >
                              <Check className="size-3.5" />
                            </button>
                          )}
                          <button
                            title="Archive"
                            onClick={() => feedClient.markAsArchived(item)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted"
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

// ---------- Variant D: Cadence popover (canonical) ----------
// The popover is for triage: the latest POPOVER_CAP Notifications, loaded on
// scroll, grouped by day, then a hand-off to the full page. The page is for
// history: same filters, explicit "Load more", a visible count.

const CATEGORY_LABEL: Record<string, string> = {
  discussions: "Discussions",
  refunds: "Refunds",
  team: "Team",
  enrollments: "Enrollments",
};
const POPOVER_CAP = 50;

function feedOptions(category: string | null, unreadOnly: boolean, pageSize: number) {
  return {
    page_size: pageSize,
    status: unreadOnly ? ("unread" as const) : ("all" as const),
    ...(category ? { trigger_data: { category } } : {}),
  };
}

function notificationsHref(category: string | null, unreadOnly: boolean) {
  const p = new URLSearchParams();
  if (category) p.set("category", category);
  if (unreadOnly) p.set("unread", "1");
  const q = p.toString();
  return `/notifications${q ? `?${q}` : ""}`;
}

/** A pressed-state toggle with a check mark, replacing the checkbox. */
function UnreadToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        on
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Check className={cn("size-3.5 transition-all", on ? "opacity-100" : "-ml-1 w-0 opacity-0")} />
      Unread
    </button>
  );
}

function FilterBar({
  categories,
  category,
  onCategory,
  unreadOnly,
  onUnreadOnly,
}: {
  categories: string[];
  category: string | null;
  onCategory: (c: string | null) => void;
  unreadOnly: boolean;
  onUnreadOnly: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {["all", ...categories].map((c) => {
          const active = (category ?? "all") === c;
          return (
            <button
              key={c}
              onClick={() => onCategory(c === "all" ? null : c)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {c === "all" ? "All" : CATEGORY_LABEL[c] ?? c}
            </button>
          );
        })}
      </div>
      <span className="h-5 w-px shrink-0 bg-border" />
      <UnreadToggle on={unreadOnly} onChange={onUnreadOnly} />
    </div>
  );
}

function useDStore() {
  const { feedClient, useFeedStore } = useKnockFeed();
  return {
    feedClient,
    items: useFeedStore((s) => s.items),
    metadata: useFeedStore((s) => s.metadata),
    pageInfo: useFeedStore((s) => s.pageInfo),
    networkStatus: useFeedStore((s) => s.networkStatus),
  };
}

function useFetchedOnce() {
  const { feedClient } = useKnockFeed();
  const [fetched, setFetched] = useState(false);
  useEffect(() => {
    feedClient.fetch().then(() => setFetched(true));
  }, [feedClient]);
  return fetched;
}

function DSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
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

function DEmpty({ category, unreadOnly }: { category: string | null; unreadOnly: boolean }) {
  const what = category ? CATEGORY_LABEL[category]?.toLowerCase() : null;
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <div className="mb-3 rounded-full bg-muted p-3">
        <BellOff className="size-6 text-muted-foreground" />
      </div>
      <p className="font-medium">
        {unreadOnly ? "You're all caught up" : what ? `No ${what} Notifications` : "No Notifications yet"}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {unreadOnly
          ? "Nothing unread here."
          : "When something concerns you, such as a reply or a refund update, it'll show up here."}
      </p>
    </div>
  );
}

/** Rows grouped under Today / Yesterday / Earlier headers. */
function DRows({
  items,
  onOpen,
  onChanged,
  stickyHeaders,
}: {
  items: FeedItem[];
  onOpen: (item: FeedItem) => void;
  onChanged: () => void;
  stickyHeaders: boolean;
}) {
  const { feedClient } = useKnockFeed();
  const groups: [string, FeedItem[]][] = [];
  for (const item of items) {
    const day = dayBucket(item.inserted_at);
    const last = groups[groups.length - 1];
    if (last && last[0] === day) last[1].push(item);
    else groups.push([day, [item]]);
  }
  return (
    <>
      {groups.map(([day, list]) => (
        <section key={day}>
          <h3
            className={cn(
              "border-b bg-popover/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur",
              stickyHeaders && "sticky top-0 z-10"
            )}
          >
            {day}
          </h3>
          <ul>
            {list.map((item) => {
              const d = dataOf(item) as Partial<NotificationData> & { category?: string };
              const k = kindOf(d.kind);
              return (
                <li key={item.id} className="group relative border-b last:border-0">
                  <button
                    onClick={() => onOpen(item)}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 pr-10 text-left transition-colors hover:bg-muted/60",
                      !item.read_at && "bg-primary/[0.04]"
                    )}
                  >
                    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", k.tone)}>
                      {k.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-sm leading-snug",
                          item.read_at ? "text-muted-foreground" : "text-foreground/80"
                        )}
                      >
                        <Message text={d.message ?? ""} />
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground/80">
                        {CATEGORY_LABEL[d.category ?? ""] ?? k.label} · {ago(item.inserted_at)}
                      </span>
                    </span>
                  </button>
                  {!item.read_at && (
                    <button
                      title="Mark as read"
                      onClick={async () => {
                        await feedClient.markAsRead(item);
                        onChanged();
                      }}
                      className="absolute right-3 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full"
                    >
                      <span className="size-2 rounded-full bg-primary group-hover:hidden" />
                      <Check className="hidden size-3.5 text-muted-foreground group-hover:block" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

export function VariantDBell() {
  const session = useContext(SessionContext);
  const { feedClient: outer, metadata } = useFeed();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // The filtered list is its own feed client; refresh the badge's feed after changes.
  const refreshBadge = () => setTimeout(() => outer.fetch(), 300);
  const count = metadata.unread_count; // unread, not unseen: stays until acted on

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
        className={cn(
          "relative rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          open && "bg-sidebar-accent text-sidebar-accent-foreground"
        )}
      >
        <Bell className="size-[18px]" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-sidebar">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="fixed left-[calc(14rem+8px)] top-2 z-40 flex max-h-[min(640px,calc(100vh-1rem))] w-[420px] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
        >
          {/* Keyed so each filter gets a fresh, server-filtered, paginated feed. */}
          <KnockFeedProvider
            key={`${category}-${unreadOnly}`}
            feedId={session?.feedId}
            defaultFeedOptions={feedOptions(category, unreadOnly, 20)}
          >
            <DPopoverPanel
              categories={session?.categories ?? []}
              category={category}
              onCategory={setCategory}
              unreadOnly={unreadOnly}
              onUnreadOnly={setUnreadOnly}
              onClose={() => setOpen(false)}
              refreshBadge={refreshBadge}
            />
          </KnockFeedProvider>
        </div>
      )}
    </>
  );
}

function DPopoverPanel({
  categories,
  category,
  onCategory,
  unreadOnly,
  onUnreadOnly,
  onClose,
  refreshBadge,
}: {
  categories: string[];
  category: string | null;
  onCategory: (c: string | null) => void;
  unreadOnly: boolean;
  onUnreadOnly: (v: boolean) => void;
  onClose: () => void;
  refreshBadge: () => void;
}) {
  const { feedClient, items, metadata, pageInfo, networkStatus } = useDStore();
  const fetched = useFetchedOnce();
  const openItem = useOpenNotification(() => {
    onClose();
    refreshBadge();
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const capped = items.length >= POPOVER_CAP;
  const more = !!pageInfo.after;

  // Load on scroll, but only up to the cap: past that, the page takes over.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || capped) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && more && networkStatus === "ready") feedClient.fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: "120px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [feedClient, more, networkStatus, capped, items.length]);

  return (
    <>
      <header className="space-y-2 border-b px-4 pb-2.5 pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Notifications</h2>
          <button
            title="Mark all as read"
            disabled={metadata.unread_count === 0}
            onClick={async () => {
              await feedClient.markAllAsRead();
              refreshBadge();
            }}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <CheckCheck className="size-4" /> Mark all read
          </button>
        </div>
        <FilterBar
          categories={categories}
          category={category}
          onCategory={onCategory}
          unreadOnly={unreadOnly}
          onUnreadOnly={onUnreadOnly}
        />
      </header>

      {!fetched && items.length === 0 ? (
        <DSkeleton />
      ) : items.length === 0 ? (
        <DEmpty category={category} unreadOnly={unreadOnly} />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <DRows items={items} onOpen={openItem} onChanged={refreshBadge} stickyHeaders />
          <div ref={sentinelRef} className="px-4 py-3 text-center text-xs text-muted-foreground">
            {capped && more
              ? `Showing the latest ${items.length} of ${metadata.total_count}`
              : more
                ? networkStatus === "fetchMore"
                  ? "Loading more…"
                  : " "
                : `That's everything · ${metadata.total_count} Notification${metadata.total_count === 1 ? "" : "s"}`}
          </div>
        </div>
      )}

      {/* Always reachable, whatever the scroll position. */}
      <footer className="border-t">
        <Link
          to={notificationsHref(category, unreadOnly)}
          onClick={onClose}
          className="flex items-center justify-center gap-1 px-4 py-2.5 text-sm font-medium text-primary hover:bg-muted/60"
        >
          View all notifications
          <ChevronRight className="size-4" />
        </Link>
      </footer>
    </>
  );
}

/** The /notifications page for Variant D: history, with explicit paging. */
export function VariantDPage() {
  const session = useContext(SessionContext);
  const { feedClient: outer } = useFeed();
  const [params, setParams] = useSearchParams();
  const category = params.get("category");
  const unreadOnly = params.get("unread") === "1";
  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true }
    );
  if (!session) return null;
  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <KnockFeedProvider
        key={`${category}-${unreadOnly}`}
        feedId={session.feedId}
        defaultFeedOptions={feedOptions(category, unreadOnly, 25)}
      >
        <DPageBody
          categories={session.categories}
          category={category}
          unreadOnly={unreadOnly}
          onCategory={(c) => set("category", c)}
          onUnreadOnly={(v) => set("unread", v ? "1" : null)}
          refreshBadge={() => setTimeout(() => outer.fetch(), 300)}
        />
      </KnockFeedProvider>
    </div>
  );
}

function DPageBody({
  categories,
  category,
  unreadOnly,
  onCategory,
  onUnreadOnly,
  refreshBadge,
}: {
  categories: string[];
  category: string | null;
  unreadOnly: boolean;
  onCategory: (c: string | null) => void;
  onUnreadOnly: (v: boolean) => void;
  refreshBadge: () => void;
}) {
  const { feedClient, items, metadata, pageInfo, networkStatus } = useDStore();
  const fetched = useFetchedOnce();
  const openItem = useOpenNotification(refreshBadge);
  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-muted-foreground">
            {fetched ? `${metadata.unread_count} unread · ${metadata.total_count} in all` : " "}
          </p>
        </div>
        <button
          disabled={metadata.unread_count === 0}
          onClick={async () => {
            await feedClient.markAllAsRead();
            refreshBadge();
          }}
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-40"
        >
          <CheckCheck className="size-4" /> Mark all as read
        </button>
      </div>
      <div className="mb-4">
        <FilterBar
          categories={categories}
          category={category}
          onCategory={onCategory}
          unreadOnly={unreadOnly}
          onUnreadOnly={onUnreadOnly}
        />
      </div>
      <div className="overflow-hidden rounded-xl border bg-popover">
        {!fetched && items.length === 0 ? (
          <DSkeleton />
        ) : items.length === 0 ? (
          <DEmpty category={category} unreadOnly={unreadOnly} />
        ) : (
          <DRows items={items} onOpen={openItem} onChanged={refreshBadge} stickyHeaders={false} />
        )}
      </div>
      {items.length > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {items.length} of {metadata.total_count}
          </span>
          {pageInfo.after ? (
            <button
              disabled={networkStatus !== "ready"}
              onClick={() => feedClient.fetchNextPage()}
              className="rounded-md border px-3 py-1.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {networkStatus === "fetchMore" ? "Loading…" : "Load more"}
            </button>
          ) : (
            <span>That's everything</span>
          )}
        </div>
      )}
    </>
  );
}

// ---------- floating switcher + prototype controls ----------

export function PrototypeSwitcher() {
  const variant = useVariant();
  const [, setParams] = useSearchParams();
  const { feedClient, items, metadata } = useFeed();
  const seed = useFetcher();

  const go = (dir: 1 | -1) => {
    const next = KEYS[(KEYS.indexOf(variant) + dir + KEYS.length) % KEYS.length];
    setParams(
      (p) => {
        p.set("variant", next);
        return p;
      },
      { replace: true }
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  const btn = "rounded-full px-2.5 py-1 text-xs font-medium hover:bg-white/15 disabled:opacity-40";
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-zinc-900 px-2 py-1.5 text-white shadow-2xl ring-1 ring-white/10">
      <button onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-56 text-center text-sm font-medium">
        {variant} ({VARIANTS[variant]})
      </span>
      <button onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronRight className="size-4" />
      </button>
      <span className="mx-1 h-5 w-px bg-white/20" />
      <seed.Form method="post" action="/prototype/feed-seed" className="flex">
        <button name="intent" value="seed" disabled={seed.state !== "idle"} className={btn}>
          {seed.state !== "idle" ? "Triggering…" : "Seed catalogue"}
        </button>
        <button name="intent" value="one" disabled={seed.state !== "idle"} className={btn}>
          +1 live
        </button>
        <button name="intent" value="hundred" disabled={seed.state !== "idle"} className={btn}>
          +100
        </button>
      </seed.Form>
      <button onClick={() => feedClient.markAllAsArchived()} className={btn}>
        Clear (empty state)
      </button>
      <span className="mx-1 h-5 w-px bg-white/20" />
      <span className="pr-2 font-mono text-[11px] text-white/70">
        total {items.length} · unread {metadata.unread_count} · unseen {metadata.unseen_count}
      </span>
    </div>
  );
}
