# Cadence

An online course platform where Students buy courses and work through their lessons.

## Language

### People

**Student**:
A person who buys or Claims their way onto courses and works through them.
_Avoid_: Learner, User, Customer

**Instructor**:
A person who speaks for their own courses only. An Instructor builds and edits the courses they own, and sees the Students enrolled on them.
_Avoid_: Teacher, Author, Creator

**Platform Admin**:
A person who runs Cadence itself, with authority over every course and Student. Only a Platform Admin decides a Refund Request.
_Avoid_: Admin (on its own), Staff, Superuser

**Team Admin**:
A person who manages a team's seats, usually because they bought them. Their authority covers only their own team.
_Avoid_: Admin (on its own), Team owner, Manager

### Buying

**Purchase**:
One payment for one course. It is either an Individual Purchase or a Team Licence.
_Avoid_: Order, Transaction, Sale

**Individual Purchase**:
A Purchase that enrolls the buyer themselves.
_Avoid_: Personal Purchase, Self purchase, Single purchase

**Team Licence**:
A Purchase of several Seats, made by a Team Admin who is not enrolled by it. Like any Purchase it is one payment: topping up buys another Team Licence, each is refunded on its own, and it belongs to the person who paid, not the team. A Claim is permanent and nothing expires.
_Avoid_: Team Purchase, Team License, Bulk purchase

**Seat**:
One place on a Team Licence, handed out as a Seat Code. A Student who Claims one gets their own Enrollment but has no Purchase of their own.
_Avoid_: Coupon, Licence

**Seat Code**:
The code a Team Admin hands out so someone can Claim a Seat.
_Avoid_: Coupon, Coupon code, Voucher

**Claim**:
When a Student uses a Seat Code and becomes enrolled.
_Avoid_: Redeem

**Claimed Seat**:
A Seat that a Student has Claimed. A Team Licence with any Claimed Seat cannot be refunded.

**Unclaimed Seat**:
A Seat that no one has Claimed yet. Once its Team Licence is refunded, it can never be Claimed.

### Learning

**Enrollment**:
A Student's access to a course's content. It ends when a Refund Request on their Purchase is approved, and a new Purchase starts a new one.
_Avoid_: Access (on its own), Subscription, Seat

**Lapsed Student**:
A Student who has lost their Enrollment on a course. Their Progress, if any, is kept, they stay on the course's roster, and they are no longer Lapsed once they buy the course again.
_Avoid_: Lapsed Enrollment, Refunded Student, Cancelled, Inactive, Unenrolled

**Progress**:
Everything a Student has done in a course: lessons completed, video watched and quiz attempts. It belongs to the Student, not the Enrollment, so it outlives an Enrollment that ends and picks up again if they buy the course again.
_Avoid_: Completion (for the whole record)

**Watched**:
How far a Student has got through a course's video: the furthest point reached in each lesson, added up. Rewatching adds nothing, and skipping ahead counts as watched.
_Avoid_: Viewed, Progress

### Refunds

**Refund Request**:
A Student's ask, with their reason, to get back what they paid for a Purchase. A Platform Admin Approves or Declines it, and never one who raised it themselves. A Purchase can have several Refund Requests over time; every one starts Open.
_Avoid_: Refund (for the ask itself), Reversal, Cancellation, Chargeback

**Open Refund Request**:
A Refund Request that no Platform Admin has decided yet. A Purchase has at most one Open Refund Request at a time.
_Avoid_: Pending, Requested, Awaiting review

**Approved Refund Request**:
A Refund Request that a Platform Admin has accepted. It creates exactly one Refund, and no further Refund Request can be raised on that Purchase.

**Declined Refund Request**:
A Refund Request that a Platform Admin has turned down. No Refund comes from it, and the Student may raise a new Refund Request afterwards.

**Refund**:
The money returned to a Student after their Refund Request is approved. It is always the full amount they paid. A declined Refund Request has no Refund. Every Refund comes from exactly one Approved Refund Request, and the Student loses access to the course at that moment.
_Avoid_: Reversal, Chargeback, Cancellation

**Pending Refund**:
A Refund whose money hasn't been confirmed as sent yet.
_Avoid_: Pending (for a Refund Request awaiting review)

**Issued Refund**:
A Refund where the money has been confirmed as sent back to the Student.
_Avoid_: Completed, Paid out

**Failed Refund**:
A Refund where the money couldn't be sent. The Refund Request stays approved, because the decision hasn't changed.

**Watch Limit**:
A Student can raise a Refund Request on an Individual Purchase only while they have Watched under two hours of the course. It never stops a Platform Admin approving one.
_Avoid_: Watch cap, Viewing threshold

**Completion Limit**:
A Student can raise a Refund Request on an Individual Purchase only while they have completed under half of the course's lessons, with or without video, counted against the course as it is now. It never stops a Platform Admin approving one.
_Avoid_: Completion cap
