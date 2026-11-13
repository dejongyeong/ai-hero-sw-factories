# Cadence

An online course platform where learners buy courses and work through their lessons.

## Language

### Refunds

**Refund Request**:
A learner's ask, with their reason, to get back what they paid for a Purchase. Staff Approve or Decline it. A Purchase can have several Refund Requests over time; every one starts Open.
_Avoid_: Refund (for the ask itself), Reversal, Cancellation, Chargeback

**Open Refund Request**:
A Refund Request that staff have not yet decided. A Purchase has at most one Open Refund Request at a time.
_Avoid_: Pending, Requested, Awaiting review

**Approved Refund Request**:
A Refund Request that staff have accepted. It creates exactly one Refund, and no further Refund Request can be raised on that Purchase.

**Declined Refund Request**:
A Refund Request that staff have turned down. No Refund comes from it, and the learner may raise a new Refund Request afterwards.

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
