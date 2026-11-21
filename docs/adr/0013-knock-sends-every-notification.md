# Knock sends every Notification

Cadence hands every Notification to Knock, a hosted provider: Knock keeps each person's Notification Feed, holds their preferences, batches, and sends the refund emails through Cadence's Postmark account instead of `app/lib/mailer.server.ts`. We chose a hosted provider over building the Feed on our own SQLite file, and we chose Knock because its free plan (10,000 messages a month) covers dev-scale use with everything Notifications need: the Feed, preferences, batching, unlimited Feed retention and separate environments. A prototype confirmed its Feed server-renders in React Router and updates live.

## Considered Options

- **Courier.** The fallback until Knock's prototype passed. Its free plan doesn't say whether its Inbox and preferences are included, and sends with its test key count against the quota.
- **Novu Cloud.** Rejected: the free plan allows 5 workflows, and fitting eleven Notifications into five would bend the domain model to a pricing limit.
- **SuprSend.** Rejected: preferences aren't on the free plan.
- **MagicBell.** Rejected: 1,000 deliveries a month, counted per channel, and it can't send through Postmark.
- **Self-hosting (Novu or our own tables).** Ruled out before any provider was compared: the provider had to be hosted.

## Consequences

- The free plan isn't hard-capped. Past 10,000 messages a month the next plan is Starter, $250/month. A refund Notification with email counts as two messages.
- The free plan may require "Powered by Knock" in the Feed, so the Feed shows Knock's footer while `branding_required` is set.
- The existing Postmark refund emails move to Knock only after one has been proven to go Knock → Postmark → inbox.
