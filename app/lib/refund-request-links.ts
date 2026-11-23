// ─── Links to a Refund Request ───
// Where a Refund Request is rendered on the admin queue, so a link (from a
// Notification, say) can land on it with the right status filter applied.

import type { RefundRequestStatus } from "~/db/schema";

export const REFUND_REQUEST_QUEUE_PATH = "/admin/refund-requests";

/** The DOM id a Refund Request's card is rendered with. */
export function refundRequestAnchor(refundRequestId: number) {
  return `refund-request-${refundRequestId}`;
}

/**
 * A link to a Refund Request that stays good once it is decided. The admin
 * queue redirects it to wherever the card is now (see refundRequestQueueHref).
 */
export function refundRequestHref(refundRequestId: number) {
  return `${REFUND_REQUEST_QUEUE_PATH}?request=${refundRequestId}`;
}

/** The path to a Refund Request's card on the queue, filtered to its status. */
export function refundRequestQueueHref(
  refundRequestId: number,
  status: RefundRequestStatus
) {
  return `${REFUND_REQUEST_QUEUE_PATH}?status=${status}#${refundRequestAnchor(refundRequestId)}`;
}
