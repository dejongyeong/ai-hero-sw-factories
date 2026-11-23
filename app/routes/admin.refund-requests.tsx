import { useEffect } from "react";
import {
  data,
  isRouteErrorResponse,
  Link,
  redirect,
  useFetcher,
} from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { count, desc, eq, sql } from "drizzle-orm";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { daysSince, formatPrice } from "~/lib/utils";
import {
  REFUND_WATCH_LIMIT_SECONDS,
  REFUND_WINDOW_DAYS,
  approvalBlocker,
  declineBlocker,
  refundLimitWarnings,
  type DecisionContext,
} from "~/lib/refund-decisions";
import {
  decideRefundRequest,
  getPurchaseKind,
  getRefundProgress,
  locateRefundRequest,
} from "~/lib/refunds.server";
import { sendEmail } from "~/lib/mailer.server";
import {
  REFUND_REQUEST_QUEUE_PATH,
  refundRequestAnchor,
} from "~/lib/refund-request-links";
import { db } from "~/db";
import {
  coupons,
  courses,
  purchases,
  refundRequests,
  users,
  RefundRequestStatus,
  UserRole,
} from "~/db/schema";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, ReceiptText } from "lucide-react";

// ─── Queries ───

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function requirePlatformAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refund requests.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Platform Admins can decide refund requests.", {
      status: 403,
    });
  }

  return currentUser;
}

function getRefundRequests(status: RefundRequestStatus) {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      decidedAt: refundRequests.decidedAt,
      decidedByUserId: refundRequests.decidedByUserId,
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      buyerUserId: purchases.userId,
      buyerName: users.name,
      buyerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, status))
    .orderBy(
      status === RefundRequestStatus.Open
        ? refundRequests.requestedAt
        : desc(refundRequests.decidedAt)
    )
    .all();
}

/** Every Seat on a Team Licence, and how many are Claimed. */
function getSeatCounts(purchaseId: number) {
  const result = db
    .select({
      total: count(),
      claimed: sql<number>`count(${coupons.redeemedAt})`,
    })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();

  return { total: result?.total ?? 0, claimed: result?.claimed ?? 0 };
}

// ─── Loader ───

const statusFilterSchema = z
  .nativeEnum(RefundRequestStatus)
  .catch(RefundRequestStatus.Open);

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline refund requests" },
  ];
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const platformAdmin = await requirePlatformAdmin(request);

  // A link to one Refund Request (refundRequestHref) opens the queue at its
  // card, under whatever status it has now.
  const linkedId = Number(url.searchParams.get("request"));
  if (Number.isInteger(linkedId) && linkedId > 0) {
    throw redirect(
      locateRefundRequest(db, linkedId) ?? REFUND_REQUEST_QUEUE_PATH
    );
  }

  const status = statusFilterSchema.parse(
    url.searchParams.get("status") ?? undefined
  );

  const rows = getRefundRequests(status).map((row) => {
    const seats = getSeatCounts(row.purchaseId);
    const purchaseKind = getPurchaseKind(db, row.purchaseId);

    // A Team Admin is not enrolled by their Team Licence, so their own
    // Progress says nothing about it.
    const progress =
      purchaseKind === "individual"
        ? getRefundProgress(db, row.buyerUserId, row.courseId)
        : null;

    const context: DecisionContext = {
      status: row.status,
      deciderUserId: platformAdmin.id,
      buyerUserId: row.buyerUserId,
      purchaseKind,
      claimedSeatCount: seats.claimed,
    };

    const decidedBy =
      row.decidedByUserId !== null ? getUserById(row.decidedByUserId) : null;

    return {
      ...row,
      purchaseKind,
      seats,
      progress,
      daysSincePurchase: daysSince(row.purchasedAt),
      warnings: progress ? refundLimitWarnings(progress) : [],
      approvalBlocker: approvalBlocker(context),
      declineBlocker: declineBlocker(context),
      decidedByName: decidedBy?.name ?? null,
    };
  });

  return { status, rows };
}

// ─── Action ───

const decisionSchema = z.object({
  intent: z.enum(["approve", "decline"]),
  refundRequestId: z.coerce.number().int(),
});

export async function action({ request }: Route.ActionArgs) {
  const platformAdmin = await requirePlatformAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, decisionSchema);
  if (!parsed.success) {
    throw data("Invalid decision.", { status: 400 });
  }
  const { intent, refundRequestId } = parsed.data;

  const decision =
    intent === "approve"
      ? RefundRequestStatus.Approved
      : RefundRequestStatus.Declined;

  const decided = await decideRefundRequest(
    db,
    refundRequestId,
    platformAdmin.id,
    decision
  );
  if (!decided.ok) {
    throw data(decided.error, { status: decided.status });
  }

  // The decision stands whether or not the email goes out.
  if (decided.email) {
    try {
      await sendEmail(decided.email);
    } catch (error) {
      console.error("Could not send the refund decision email:", error);
    }
  }

  return {
    success: true,
    message:
      decision === RefundRequestStatus.Approved
        ? "Refund request approved."
        : "Refund request declined.",
  };
}

// ─── Component ───

const STATUS_TABS: { value: RefundRequestStatus; label: string }[] = [
  { value: RefundRequestStatus.Open, label: "Open" },
  { value: RefundRequestStatus.Approved, label: "Approved" },
  { value: RefundRequestStatus.Declined, label: "Declined" },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWatched(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

type Row = Route.ComponentProps["loaderData"]["rows"][number];

function DecisionButtons({ row }: { row: Row }) {
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  const blocker = row.approvalBlocker ?? row.declineBlocker;

  return (
    <div className="space-y-2">
      <fetcher.Form method="post" className="flex gap-2">
        <input type="hidden" name="refundRequestId" value={row.id} />
        <Button
          type="submit"
          name="intent"
          value="approve"
          size="sm"
          disabled={submitting || row.approvalBlocker !== null}
        >
          Approve
        </Button>
        <Button
          type="submit"
          name="intent"
          value="decline"
          size="sm"
          variant="outline"
          disabled={submitting || row.declineBlocker !== null}
        >
          Decline
        </Button>
      </fetcher.Form>
      {blocker && (
        <p className="max-w-56 text-xs text-muted-foreground">{blocker}</p>
      )}
    </div>
  );
}

function RefundRequestCard({ row }: { row: Row }) {
  // The id lets a Refund Request raised Notification scroll to and highlight
  // this card (HighlightAnchor).
  return (
    <Card id={refundRequestAnchor(row.id)} className="scroll-mt-6">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{row.buyerName}</span>
              <span className="text-sm text-muted-foreground">
                {row.buyerEmail}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                {row.purchaseKind === "team"
                  ? `Team Licence · ${row.seats.total} Seats`
                  : "Individual Purchase"}
              </span>
            </div>
            <Link
              to={`/courses/${row.courseSlug}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {row.courseTitle}
            </Link>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold">
              {formatPrice(row.amountPaid)}
            </div>
            <div className="text-xs text-muted-foreground">
              Requested {formatDate(row.requestedAt)}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Since purchase</dt>
            <dd>
              {row.daysSincePurchase} of {REFUND_WINDOW_DAYS} days
            </dd>
          </div>
          {row.progress ? (
            <>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Lessons completed
                </dt>
                <dd>
                  {row.progress.completedLessons} of{" "}
                  {row.progress.totalLessons}
                  {row.progress.totalLessons > 0 &&
                    ` (${Math.round(
                      (row.progress.completedLessons /
                        row.progress.totalLessons) *
                        100
                    )}%)`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Watched</dt>
                <dd>
                  {formatWatched(row.progress.secondsWatched)} of{" "}
                  {formatWatched(REFUND_WATCH_LIMIT_SECONDS)}
                </dd>
              </div>
            </>
          ) : (
            <div>
              <dt className="text-xs text-muted-foreground">Seats claimed</dt>
              <dd>
                {row.seats.claimed} of {row.seats.total}
              </dd>
            </div>
          )}
        </dl>

        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
          {row.reason}
        </blockquote>

        {row.warnings.length > 0 && (
          <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" />
              Past a refund limit since asking
            </div>
            <ul className="mt-1 list-disc pl-6">
              {row.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {row.status === RefundRequestStatus.Open ? (
          <DecisionButtons row={row} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {row.status === RefundRequestStatus.Approved
              ? "Approved"
              : "Declined"}
            {row.decidedByName && ` by ${row.decidedByName}`}
            {row.decidedAt && ` on ${formatDate(row.decidedAt)}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { status, rows } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline what students have asked to get back
        </p>
      </div>

      <div className="mb-6 flex gap-2">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            to={`?status=${tab.value}`}
            className={
              tab.value === status
                ? "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No {status} refund requests.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <RefundRequestCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/admin/refund-requests">
          <Button>Back to Refund Requests</Button>
        </Link>
      </div>
    </div>
  );
}
