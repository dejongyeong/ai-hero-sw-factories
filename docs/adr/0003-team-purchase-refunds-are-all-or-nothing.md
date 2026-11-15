# Team Purchase refunds are all-or-nothing, and a Claimed Seat blocks them

Only the Team Admin can raise a Refund Request on a Team Purchase, and it is always for the full amount. Once any Seat is Claimed, the whole Team Purchase can't be refunded. This also applies to a Seat Claimed while the request is Open: Approve is blocked, and the request can only be Declined. When a refund on a Team Purchase is approved, its Unclaimed Seats can never be Claimed.

This keeps the rule that a Refund is always the full amount paid. It also means no Student ever keeps an Enrollment that a refunded Purchase was paying for. A Student on a Claimed Seat has no Purchase of their own, so they can't raise a Refund Request.

## Considered Options

- **Refund just the Unclaimed Seats** (e.g. $237 of $395 when 2 of 5 Seats are Claimed). This is fairer to the Team Admin, but it breaks "always the full amount" and needs a new concept for refunding a single Seat. Rejected for now; it needs its own design.
- **Approve anyway and end the Claimed Seat holders' Enrollments.** Rejected, because it takes access away from Students who did nothing.
