# Cadence

An online course platform where learners buy courses and work through their lessons.

## Language

### People

**Platform Admin**:
A person who runs Cadence itself, with authority over every course and learner. Only a Platform Admin decides a Refund Request.
_Avoid_: Admin (on its own), Staff, Superuser

**Team Admin**:
A person who manages a team's seats, usually because they bought them. Their authority covers only their own team.
_Avoid_: Admin (on its own), Team owner, Manager

### Buying

**Purchase**:
One payment for one course. It is either an Individual Purchase or a Team Purchase.
_Avoid_: Order, Transaction, Sale

**Individual Purchase**:
A Purchase that enrolls the buyer themselves.
_Avoid_: Personal Purchase, Self purchase, Single purchase

**Team Purchase**:
A Purchase of several Seats, made by a Team Admin who is not enrolled by it.
_Avoid_: Team Licence, Bulk purchase

**Seat**:
One place on a Team Purchase, handed out as a Seat Code. A learner who Claims one gets their own Enrollment but has no Purchase of their own.
_Avoid_: Coupon, Licence

**Seat Code**:
The code a Team Admin hands out so someone can Claim a Seat.
_Avoid_: Coupon, Coupon code, Voucher

**Claim**:
When a learner uses a Seat Code and becomes enrolled.
_Avoid_: Redeem

**Claimed Seat**:
A Seat that a learner has Claimed. A Team Purchase with any Claimed Seat cannot be refunded.

**Unclaimed Seat**:
A Seat that no one has Claimed yet. Once its Team Purchase is refunded, it can never be Claimed.

### Learning

**Enrollment**:
A learner's access to a course's content. It ends when a Refund Request on their Purchase is approved, and a new Purchase starts a new one.
_Avoid_: Access (on its own), Subscription, Seat

**Progress**:
Everything a learner has done in a course: lessons completed, video watched and quiz attempts. It belongs to the learner, not the Enrollment, so it outlives an Enrollment that ends and picks up again if they buy the course again.
_Avoid_: Completion (for the whole record)

### Refunds

**Refund Request**:
A learner's ask, with their reason, to get back what they paid for a Purchase. A Platform Admin Approves or Declines it, and never one who raised it themselves. A Purchase can have several Refund Requests over time; every one starts Open.
_Avoid_: Refund (for the ask itself), Reversal, Cancellation, Chargeback

**Open Refund Request**:
A Refund Request that no Platform Admin has decided yet. A Purchase has at most one Open Refund Request at a time.
_Avoid_: Pending, Requested, Awaiting review

**Approved Refund Request**:
A Refund Request that a Platform Admin has accepted. It creates exactly one Refund, and no further Refund Request can be raised on that Purchase.

**Declined Refund Request**:
A Refund Request that a Platform Admin has turned down. No Refund comes from it, and the learner may raise a new Refund Request afterwards.

**Refund**:
The money returned to a learner after their Refund Request is approved. It is always the full amount they paid. A declined Refund Request has no Refund. Every Refund comes from exactly one Approved Refund Request, and the learner loses access to the course at that moment.
_Avoid_: Reversal, Chargeback, Cancellation

**Pending Refund**:
A Refund whose money hasn't been confirmed as sent yet.
_Avoid_: Pending (for a Refund Request awaiting review)

**Issued Refund**:
A Refund where the money has been confirmed as sent back to the learner.
_Avoid_: Completed, Paid out

**Failed Refund**:
A Refund where the money couldn't be sent. The Refund Request stays approved, because the decision hasn't changed.
