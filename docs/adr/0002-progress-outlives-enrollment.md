# Progress outlives an Enrollment, and still counts towards a later refund

When an Enrollment ends after a refund, we keep the learner's Progress (lessons completed, video watched, quiz attempts) and only remove their access. If they buy the course again, they pick up where they left off. That carried-over Progress also counts towards the refund limits (2 hours watched, 50% of lessons completed) on the new Purchase. Only the 14-day window starts again.

We kept Progress because deleting it can't be undone, and it's the evidence a Platform Admin used to decide. We let it count again so nobody can watch the course for free by refunding and buying again over and over.

## Considered Options

- **Delete Progress on approval.** This gives a clean slate if they buy again, but it can't be undone and loses the record of what the learner did before the refund.
- **Keep Progress, but reset the refund limits on a new Purchase.** This is friendlier to learners, but it allows the refund-and-rebuy loop.
