# Hosted notification providers compared

Research for issue #3 (child of map #2, "Notifications in Cadence"). All pricing and free-tier facts were **checked on 2026-11-17** against the vendor pages linked below. Vendors change prices often, so re-check before committing to one.

Terms: a **Notification** is one message Cadence sends to a person. The **Notification Feed** is the in-app list of a person's Notifications. Vendors call this "inbox" or "feed". Cadence says Notification Feed.

Constraints (from map #2): hosted only. A free tier covering dev-scale use is a hard requirement. React Router + Vite + Node/TypeScript, one SQLite file through Drizzle. Existing email goes through Postmark. "Push" means browser web push (Cadence has no mobile app).

## Verdict at a glance

| | Knock | Novu Cloud | Courier | MagicBell | SuprSend |
|---|---|---|---|---|---|
| **Free tier** | 10,000 messages/mo | 10,000 workflow runs/mo, **max 5 workflows** | 10,000 sends/mo | **1,000 deliveries/mo**, counted per channel | 10,000 notifications/mo, **no preferences** |
| **Free tier enough for dev?** | Yes | Yes, but 5 workflows is tight | Yes | Borderline | Yes for volume, but preferences are paywalled |
| **Prebuilt React Feed** | Yes (`@knocklabs/react`) | Yes (`@novu/react` `<Inbox />`) | Yes (`@trycourier/courier-react`) | Yes (`@magicbell/react`) | Yes (`@suprsend/react`) |
| **Headless hooks** | Yes | Yes | Low-level client only | Not documented | Yes |
| **Live updates** | Yes, websocket | Yes, websocket | Yes, "real-time socket" | Yes, "persistent connection" | Yes, websocket |
| **Web push** | Via FCM (tutorial) | Via FCM / OneSignal / Pusher Beams / Pushpad | Via FCM / OneSignal | **Native** (`WebPushButton`) | **Native** (VAPID keys from SuprSend) |
| **Email through our Postmark** | Yes | Yes | Yes | **No** (Postmark not listed) | Yes |
| **Recipient preferences** | Per workflow, category, channel | Per workflow + global, per channel; Inbox has Preferences view | Per topic, per channel; hosted page | Per category, per channel; `UserPreferences` component | Per category, per channel, **not on Free** |
| **Node/TS server SDK** | `@knocklabs/node` | `@novu/api` | Courier Node SDK | `magicbell-js` (browser/Node client) | `@suprsend/node-sdk` |
| **Client auth** | Public key + RS256 signed user token | App ID + HMAC-SHA256 `subscriberHash` | Backend-issued scoped JWT | HS256 User JWT | Public key + signed user JWT |
| **Dev / test mode** | Dev env + channel sandbox mode | Dev env (separate keys) | Test env keys; mock keys maybe Enterprise only | Not found | Staging workspace + Test Mode |

**Candidates that pass the hosted + free-tier bar:** Knock, Novu Cloud, Courier, SuprSend (all 10,000/month free). MagicBell is hosted with a $0 plan, but 1,000 deliveries a month, counted per channel, is thin. It also cannot send through Postmark.

**Notable trade-offs (no pick here, that is the "Choose the provider" ticket):**

- **Knock** has the fullest free plan: unlimited environments, unlimited Feed retention, preferences included, and sandbox mode. Web push is not a first-class channel. It goes through FCM. The next tier is a big jump, to $250/mo.
- **Novu Cloud** gives you Feed, preferences UI, and websockets in one `<Inbox />`, and the docs show React Router wiring. The Free plan caps you at **5 workflows**, which may be too few for a catalogue covering four roles. Activity log retention is 24h. The cheapest paid tier is $30/mo.
- **Courier** has good Postmark support and pay-as-you-go pricing after the free tier ($0.005/send). Sends from Test-environment keys count against the 10,000. The free-plan coverage of Inbox and preferences is not stated on the pricing page.
- **MagicBell** is the only one, besides SuprSend, with native browser web push. But it has no Postmark and the smallest free tier.
- **SuprSend** has native web push, Postmark, and a real Test Mode. **Preferences (channel, category, preference centre) are "Not included" on Free.** The Feed carries SuprSend branding on Free.

---

## Knock

**Free tier** (checked 2026-11-17, <https://knock.app/pricing>):

- $0/mo. Up to **10,000 messages sent**. Bounced or failed messages are not counted.
- Unlimited channels. Unlimited feeds per recipient with **unlimited feed retention**. Preferences included. **Unlimited isolated environments**. 30-day logs. Knock branding cannot be removed on Free.
- No hard cap. If you exceed it without a billing method, Knock contacts you.
- Next tier: Starter, $250/mo, with 50,000 messages, then $0.005 each.

**Notification Feed:** `@knocklabs/react` ships `KnockProvider`, `KnockFeedProvider`, `NotificationIconButton`, `NotificationFeedPopover` and `NotificationFeed`. It is themed with `--rnf-` CSS variables and supports dark mode. The feed is "a real-time feed component" over socket connections, with optional auto-disconnect of inactive tabs and cross-tab sync. Source: <https://docs.knock.app/in-app-ui/react/feed>.

Headless: `useNotifications` + `useNotificationStore`. Note that the headless hooks don't mark items seen automatically. Sources: <https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notifications>, <https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notification-store>, <https://docs.knock.app/in-app-ui/react/headless/feed>.

SSR: the docs pages consulted say nothing about SSR. The components need browser sockets, so expect to render them client-only under React Router. That is an inference, not something the docs state.

**Web push:** the push integrations page lists APNs, FCM (labelled Android), Expo, Amazon SNS and OneSignal (<https://docs.knock.app/integrations/push/overview>). Browser push is documented as a tutorial using FCM: register the browser with the Firebase SDK, then store the token as channel data on the Knock user (<https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm>). There is no native VAPID channel.

**Email via Postmark:** yes. You give it your Postmark server's API key and a From address. It uses the default `outbound` stream unless you override `MessageStream`. An optional Postmark webhook reports delivery status. Source: <https://docs.knock.app/integrations/email/postmark>.

**Preferences:** each user has a `PreferenceSet` that can opt out by channel type, category or workflow. "A message will not send if the user has opted out." Source: <https://docs.knock.app/concepts/preferences>. React: the `usePreferences` hook (<https://docs.knock.app/in-app-ui/react/sdk/hooks/use-preferences>) and a PreferenceCenter guide (<https://docs.knock.app/in-app-ui/react/preferences>). There is also a hosted preference centre (<https://docs.knock.app/preferences/hosted-preference-center>).

**Server SDK and identity:** `@knocklabs/node`. Recipients are identified by your own user id string.

**Client auth:** the client uses a public API key plus a user id. Without "enhanced security mode", anyone with the public key can act as any user, so the docs say to turn it on for production. The backend then signs an **RS256 JWT** (`sub` = user id) with the private signing key (`KNOCK_SIGNING_KEY`) using `signUserToken` from `@knocklabs/node`. The default expiry is 3600s. Source: <https://docs.knock.app/in-app-ui/security-and-authentication>.

**Dev / test:** separate development and production environments, each with its own data, keys and provider credentials (<https://docs.knock.app/concepts/environments>). **Channel sandbox mode** builds messages without forwarding them to the provider. It works for every channel type except in-app. The workflow test runner can also force sandbox mode, via the API `settings.sandbox_mode` (<https://docs.knock.app/send-notifications/testing-workflows>). A built-in "Knock test" email channel sends only to Knock account members (<https://docs.knock.app/integrations/email/knock-test>).

## Novu Cloud

**Free tier** (checked 2026-11-17, <https://novu.co/pricing>):

- $0/mo, no card required. **10,000 workflow runs/mo**, **up to 5 workflows**, 2 environments (Dev + Prod), 24h activity feed retention, up to 3 team members, US or EU data residency.
- "All channels: Email, In-app, SMS, Chat, Push".
- The pricing page's comparison table shows `<Inbox />` and `<Preferences />` component rows, but the per-plan cells are icons that would not extract. Confirm in the rendered page that they are on Free.
- Next tier: Pro, from $30/mo, with 30,000 runs and 20 workflows, then $1.20 per 1,000 runs.

**Notification Feed:** `@novu/react` `<Inbox />` is a prebuilt bell + feed + preferences view. It can be composed from `Bell`, `Notifications`, `InboxContent` and `Preferences` (<https://docs.novu.co/platform/inbox/overview>).

Headless hooks: `useNotifications`, `useCounts` and `useNovu`. They "automatically listen for real-time events and update your component state" (<https://docs.novu.co/platform/inbox/react/headless>).

Transport: websocket. The production guide gives an EU `socketUrl` of `wss://eu.socket.novu.co` (<https://docs.novu.co/platform/inbox/prepare-for-production>).

The React quickstart wires `<Inbox />` navigation to React Router's `useNavigate` (<https://docs.novu.co/platform/quickstart/react>).

**Web push:** push providers are FCM, Expo, APNs, OneSignal, Push Webhook, Pusher Beams and Pushpad (<https://docs.novu.co/platform/integrations/push>). Pushpad is a dedicated browser web push service (<https://docs.novu.co/platform/integrations/push/pushpad>). Any of these is an extra vendor. There is no native VAPID channel.

**Email via Postmark:** yes. You give it the Postmark Server API token and a verified From address (<https://docs.novu.co/platform/integrations/email/postmark>).

**Preferences:** workflow-level channel defaults, plus subscriber global preferences and per-workflow preferences. "The most specific layer that defines a channel wins." "Critical" workflows cannot be opted out of. The Inbox Preferences view lets subscribers manage them. Source: <https://docs.novu.co/platform/concepts/preferences>.

**Server SDK and identity:** `@novu/api`. Call `novu.trigger({ workflowId, to: { subscriberId, email, ... }, payload })`. Subscribers are identified by `subscriberId`, which is your own user id (<https://docs.novu.co/platform/sdks/server/typescript>).

**Client auth:** an `applicationIdentifier` (safe to expose) plus `subscriberId`. For production, enable HMAC. The server computes `HMAC-SHA256(NOVU_SECRET_KEY, subscriberId)` and passes it as `subscriberHash`. Source: <https://docs.novu.co/platform/inbox/prepare-for-production>.

**Dev / test:** Development and Production environments, each with its own keys, integrations and subscribers. Workflows are edited in Development and published (<https://docs.novu.co/platform/concepts/environments>). No documented sandbox or "don't deliver" mode was found. Isolation depends on the Development environment's provider credentials.

## Courier

**Free tier** (checked 2026-11-17, <https://www.courier.com/pricing>, <https://www.courier.com/docs/workspaces/billing>):

- Developer plan: free, **10,000 sends/mo**.
- One send is one template to one recipient, however many channels it reaches. Bounced sends and sends blocked by preferences still count. **Sends made with Test keys count the same as Production sends.**
- What happens past 10,000 on Developer is not stated in Courier's docs. Adding a card moves the workspace to Business at $0.005/send, pay as you go.
- The pricing page does not say whether Inbox, preferences, or the Test environment are on Developer.

**Notification Feed:** `@trycourier/courier-react` (React 18+), `<CourierInbox />`, with unread badges, read and archive actions, pagination and theming. `@trycourier/courier-ui-inbox` is a Web Components alternative. "Messages arrive in real time" (<https://www.courier.com/docs/platform/inbox/inbox-overview>). The auth page mentions a "real-time socket" (<https://www.courier.com/docs/platform/inbox/authentication>). There are no documented headless hooks, only `useCourier()` and "low-level APIs".

**Web push:** through FCM (Android/iOS/Web) or OneSignal integrations (<https://www.courier.com/docs/integrations/push/overview>, <https://www.courier.com/docs/external-integrations/push/onesignal>). There is no native channel.

**Email via Postmark:** yes. "Keep Postmark as your email provider. Courier sends through your Postmark account." You give it the Server API token and a From address (<https://www.courier.com/docs/external-integrations/email/postmark>).

**Preferences:** subscription topics, each with a default of `OPTED_IN`, `OPTED_OUT` or `REQUIRED`. Users can choose channels per topic when the topic allows it. There is an in-app preference centre or a hosted page. Source: <https://www.courier.com/docs/platform/preferences/preferences-overview>.

**Server SDK and identity:** Courier Node SDK. Recipients are identified by your own `user_id`.

**Client auth:** the backend calls `POST /auth/issue-token` with a scope like `user_id:<id> inbox:read:messages inbox:write:events`, plus optional preference scopes, and an `expires_in`. If `expires_in` is omitted, the token **never expires**. There is no automatic refresh. Source: <https://www.courier.com/docs/platform/inbox/authentication>.

**Dev / test:** a Test environment with its own keys (`pk_test_…`) and per-integration Test Configuration, so you can point it at a sandbox provider key (<https://www.courier.com/docs/platform/workspaces/environments-api-keys>). Mock keys simulate delivery with a `SIMULATED` status, but one Courier source lists them under Enterprise. Confirm the plan.

## MagicBell

**Free tier** (checked 2026-11-17, <https://www.magicbell.com/pricing>):

- Builder: $0/mo, **1,000 deliveries/mo**, 1 project, unlimited users and team members.
- Deliveries are counted **per channel**. "We add up all the channels a user receives a notification on."
- Next tier: Startup, $249/mo, with 50,000 deliveries, then $0.0025 each.

**Notification Feed:** `@magicbell/react` provides `ContextProvider`, `Inbox`, `FloatingInbox`, `InlineNotification`, `ToastContainer`, `UserPreferences` and `WebPushButton` (<https://www.magicbell.com/docs/libraries/magicbell-react>). There are no documented headless hooks. Live: "MagicBell maintains a persistent connection to deliver notifications in real-time" (<https://www.magicbell.com/docs/channels/in_app>). The transport is not named.

**Web push:** native. `WebPushButton` "Uses the Push API to register or remove the user's subscription", with a service worker that loads MagicBell's script (<https://www.magicbell.com/docs/libraries/magicbell-react>, <https://www.magicbell.com/docs/channels/web_push>).

**Email via Postmark:** **no**. Supported email providers are SendGrid, Amazon SES, SMTP, Mailgun and Ping Email (<https://www.magicbell.com/docs/channels/email>). Postmark offers SMTP, so the generic SMTP option might work, but MagicBell's docs don't say so.

**Preferences:** per category and per channel, with a `UserPreferences` React component (<https://www.magicbell.com/docs/libraries/magicbell-react>, <https://community.magicbell.io/docs/categories>).

**Server SDK and identity:** `magicbell-js`, a browser/Node client (<https://www.magicbell.com/docs/libraries/magicbell-js>). Users are identified by `user_external_id` and/or `user_email`.

**Client auth:** an **HS256 User JWT** signed with the project Secret Key on the backend. Claims are `user_external_id` or `user_email`, plus `api_key`. The examples use a 1-year expiry (<https://www.magicbell.com/docs/api/authentication/user>).

**Dev / test:** no test or sandbox mode was found in the docs consulted. The free plan has 1 project.

## SuprSend

**Free tier** (checked 2026-11-17, <https://www.suprsend.com/pricing>):

- $0/mo, **10,000 notifications/mo**. Overage keeps processing and SuprSend contacts you.
- Unlimited channels: Email, SMS, WhatsApp, Mobile Push, **Web Push**, Slack, MS Teams, In-app. In-app inbox, headless inbox and toasts are included, with **SuprSend branding**. Multiple environments. 30-day logs.
- **Not included on Free:** channel preferences, category preferences, the preference centre UI, the hosted preference page, batching, digest and throttling.
- Next tier: Essentials, $100/mo, with 50,000 notifications, then $2 per 1,000.

**Notification Feed:** `@suprsend/react`. The old `@suprsend/react-inbox` is discontinued. It has drop-in components and headless hooks (<https://docs.suprsend.com/docs/inbox-react>). The component "handles WebSocket connections, notification state, pagination, and real-time updates". Toasts are now wired by hand from the `feed.new_notification` event (<https://docs.suprsend.com/docs/react-toast-notifications>).

**Web push:** native. SuprSend generates the VAPID keys (Vendors → Web Push). The React `SuprSendProvider` takes `vapidKey`, and you add their script to your service worker with `importScripts` (<https://docs.suprsend.com/docs/react-webpush>, <https://docs.suprsend.com/docs/js-webpush>).

**Email via Postmark:** yes. You give it a Server Token, an optional Account Token, a verified From address, and optionally a Postmark webhook for delivery, open and click status (<https://docs.suprsend.com/docs/postmark>).

**Preferences:** per category and per channel through API and SDK (<https://docs.suprsend.com/docs/js-preferences>), but **paywalled above Free** (see pricing).

**Server SDK and identity:** `@suprsend/node-sdk`. Call `trigger_workflow` with recipients identified by `distinct_id`, your own user id, or as inline objects. Up to 100 recipients per call (<https://docs.suprsend.com/docs/node-trigger-workflow-from-api>).

**Client auth:** the client identifies with `identify(distinctId, userToken)`. In enhanced security mode, the backend signs a JWT (`entity_type: subscriber`, `entity_id: distinct_id`, `exp`) with a signing key from the dashboard (<https://docs.suprsend.com/docs/client-authentication>).

**Dev / test:** each account gets Sandbox, Staging and Production workspaces, with credentials scoped per workspace. **Test Mode** works in Staging only. It delivers only to designated internal testers, with an optional catch-all (<https://docs.suprsend.com/docs/developer/test-mode>, <https://docs.suprsend.com/docs/workspaces>).

## Others found

- **Pingram, formerly NotificationAPI.** `notificationapi.com/pricing` now redirects to <https://www.pingram.io/pricing>. The Free plan has 3,000 emails, 100 SMS and 100 call minutes a month. The pricing page lists no in-app or web push allowances, so it was not evaluated further.

## Gaps and things to confirm before choosing

- **SSR under React Router.** None of the vendors document React Router SSR. Every Feed component opens a socket and touches browser APIs. Plan on mounting the Feed client-only, for example after hydration. This needs a quick spike with the chosen SDK.
- **Novu:** whether `<Inbox />` and `<Preferences />` are on Free (icon cells on the pricing page). Whether 5 workflows covers the catalogue.
- **Courier:** whether Inbox, preferences and the Test environment are on Developer. What happens past 10,000 sends on Developer.
- **MagicBell:** whether Postmark works through generic SMTP. Any test mode.
- **Cost past the free tier:** listed above per vendor, but out of scope for this ticket. See map #2 "Not yet specified".
