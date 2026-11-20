// PROTOTYPE — throwaway. Lives only on the `prototype/notification-feed` branch; never merge.
// "What the Notification Feed looks like" (dejongyeong/ai-hero-sw-factories#8):
// three structurally different Feeds, switchable via ?variant= and the bottom bar.
//   A  Knock stock — bell + count badge in the sidebar header, Knock's own popover and cells.
//   B  Feed page   — "Notifications" sidebar item with count pill → full /notifications page.
//   C  Drawer      — bell with a dot in the user row → right-hand slide-over, Cadence-styled cards.
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
};

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

function useOpenNotification(onDone?: () => void) {
  const { feedClient } = useKnockFeed();
  const navigate = useNavigate();
  return (item: FeedItem) => {
    feedClient.markAsRead(item);
    onDone?.();
    const url = dataOf(item).url;
    if (url) navigate(url);
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
