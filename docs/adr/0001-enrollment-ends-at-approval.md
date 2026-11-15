# Enrollment ends when a Refund Request is approved, not when the Refund is issued

A Student's Enrollment ends the moment a Platform Admin approves their Refund Request, even though the Refund is still Pending and the money may not have been sent. We tied it to the decision, not the money, so that cutting access doesn't depend on a payment flow that hasn't been built yet. It also means a Student can't keep watching while the money is on its way. Until the request is decided, the Student keeps full access, so a declined Student never loses anything.

## Consequences

- A Failed Refund does not give access back. The decision still stands, and the Student is now owed money while locked out. Whoever designs the money side has to handle that case.
