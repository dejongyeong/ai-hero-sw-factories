// ─── Links to a Refund Request ───
// Where a Refund Request is rendered on the admin queue, so a link (from a
// Notification, say) can land on it with the right status filter applied.

import type { RefundRequestStatus } from "~/db/schema";

/** The DOM id a Refund Request's card is rendered with. */
export function refundRequestAnchor(refundRequestId: number) {
  return `refund-request-${refundRequestId}`;
}

/** The path to a Refund Request on the admin queue, filtered to its status. */
export function refundRequestHref(
  refundRequestId: number,
  status: RefundRequestStatus
) {
  return `/admin/refund-requests?status=${status}#${refundRequestAnchor(refundRequestId)}`;
}
