# Web push for a web-only app

Research for issue #4 (child of map #2, "Notifications in Cadence"). Researched 2026-11-17.

**Question:** Cadence has no mobile app. How viable is browser web push for it?

**Short answer:** Viable. Every major desktop and mobile browser has supported standard Web Push (Push API + Notifications API + Service Worker, authenticated with VAPID) since March 2023. iOS/iPadOS is the big exception: push works only once the user has added Cadence to the Home Screen. The setup is small in a React Router + Vite app, which needs a static service worker in `public/`, a web app manifest, a VAPID key pair and a subscription store. The main cost is reach: users must opt in through a browser prompt, and iPhone users must also install the site. Among the hosted notification providers, **only some deliver browser push natively**. Knock has no first-party web push. It goes through FCM. Courier and Novu route it through third-party push vendors. MagicBell and SuprSend have a native web push channel. Email or an in-app Notification Feed has to stay the fallback.

---

## 1. Browser support (as of 2026-11-17)

From MDN browser-compat-data v8.1.9 (2026-11-12), `api.PushManager.subscribe`:

| Browser | Since | Notes |
| --- | --- | --- |
| Chrome (desktop) | 42 | `applicationServerKey` (VAPID) required |
| Edge | 17 | `applicationServerKey` required |
| Firefox (desktop) | 44 | From 72, only callable from a user gesture |
| Firefox Android | 48 | From 79, only from a user gesture |
| Chrome Android | 42 | `applicationServerKey` required |
| Samsung Internet | 4.0 | `applicationServerKey` required |
| Safari (macOS) | 16 | "Notifications are supported on macOS Ventura and later." |
| Safari iOS/iPadOS | 16.4 | "Notifications are supported in web apps saved to the home screen." |

Source: https://github.com/mdn/browser-compat-data (`data.json` via unpkg `@mdn/browser-compat-data@8.1.9`). MDN marks the Push API "Baseline: Widely available" since March 2023 (https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

### Safari / iOS details

- **macOS Safari 16 (Ventura+), June 2022.** It uses the standard Push API, Notifications API and Service Workers. **No Apple Developer Program membership is needed.** Subscribing requires an explicit user gesture. `userVisibleOnly: true` is mandatory, and a push that doesn't show a notification gets the subscription revoked. If you allowlist endpoints, allow any subdomain of `push.apple.com`. Source: WebKit, "Meet Web Push", 2022-06-07, https://webkit.org/blog/12945/meet-web-push/
- **iOS/iPadOS 16.4, Feb 2023 (beta announcement).** "A web app that has been added to the Home Screen can request permission to receive push notifications." Permission must come from a direct user interaction such as tapping a button. Home Screen web apps also get the Badging API (`setAppBadge` / `clearAppBadge`). Source: WebKit, "Web Push for Web Apps on iOS and iPadOS", 2023-02-16, https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
  - **In a normal Safari tab on iPhone there is no web push at all.** The user has to use Share, then Add to Home Screen, open Cadence from that icon, and only then tap your "enable notifications" control.
- **iOS/iPadOS 26 (fall 2025).** "By default, every website added to the Home Screen opens as a web app." The "Open as Web App" toggle is on by default. Before this, a site needed the right meta tag or a manifest `display` value. A proper manifest is still recommended for icon, name and `display: standalone`. Source: WebKit, "News from WWDC25: WebKit in Safari 26 beta", 2025-06-09, https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- **Declarative Web Push (iOS/iPadOS 18.4, macOS 15.5).** A standardized JSON payload lets Safari show the notification without running a service worker. The service worker becomes optional and can still modify the message. The same payload falls back to normal JS handling in older browsers. Apple says it avoids the silent-push penalties and the ITP-related subscription loss of classic Web Push. It's a nice-to-have, not a requirement. Source: WebKit, "Meet Declarative Web Push", 2025-03-27, https://webkit.org/blog/16535/meet-declarative-web-push/
- **EU caveat (historical).** In Feb 2024 Apple planned to drop Home Screen web apps in the EU under the DMA. It reversed that before iOS 17.4 shipped in March 2024. Source: secondary press coverage of Apple's developer support note, for example https://www.macrumors.com/2024/03/01/apple-walks-back-decision-to-disable-eu-web-apps/. The Apple note itself wasn't retrieved.

## 2. What the setup needs in a React Router / Vite app

Cadence uses React Router 8.3 in framework mode (`ssr: true`), on Vite 7 (`package.json`, `react-router.config.ts`). The pieces:

1. **Secure context.** `PushManager.subscribe` works only over HTTPS. `localhost` counts as secure for development. Source: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
2. **A service worker file.** Put a plain `public/sw.js` in place. Vite serves `public/` at the site root, so the worker's scope is `/`. It needs:
   - a `push` listener that calls `self.registration.showNotification(...)` inside `event.waitUntil` (https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event)
   - a `notificationclick` listener that focuses or opens the relevant Cadence URL
   - optionally a `pushsubscriptionchange` listener to re-subscribe and tell the server (https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
   - Push alone needs no build step. If Cadence later wants offline caching too, `vite-plugin-pwa` with `strategies: 'injectManifest'` compiles a custom worker (`srcDir` / `filename`) and injects the Workbox precache manifest. `devOptions.enabled` turns it on in dev. Source: https://vite-pwa-org.netlify.app/guide/inject-manifest.html. vite-pwa has no React Router framework-mode guide. Note that React Router's lazy route discovery (`/__manifest` requests) is a known snag when a worker also caches navigation. See https://github.com/remix-run/react-router/discussions/14588. **Push-only doesn't hit that problem.**
3. **Registration on the client.** Call `navigator.serviceWorker.register('/sw.js')` from client-only code, for example a `useEffect` in `app/root.tsx`. It must not run during SSR.
4. **A web app manifest**, for example `public/manifest.webmanifest` linked from `root.tsx` `links`. iPhone users need it so Cadence installs to the Home Screen with a proper name and icon (see section 1).
5. **A VAPID key pair.** Generate it once and keep the private key server-side, for example in env. Chrome, Edge and Samsung require `applicationServerKey` in `subscribe()` (MDN BCD). Each message is signed with a VAPID JWT. Source: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
6. **The subscribe flow.** It runs from a click handler:
   1. `Notification.requestPermission()`
   2. `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
   3. POST the `PushSubscription` JSON (endpoint plus `p256dh`/`auth` keys) to a React Router action, which stores it per user. A user can have many devices.
7. **Server-side sending.** The `web-push` npm library handles payload encryption and VAPID signing: `setVapidDetails(subject, publicKey, privateKey)` and `sendNotification(subscription, payload, { TTL, urgency, topic })`. Failures expose `statusCode`. Delete stored subscriptions that come back 404/410. Source: https://github.com/web-push-libs/web-push
8. **Security.**
   - The subscription endpoint is a capability URL, so keep it secret.
   - Protect the subscribe endpoint against CSRF.
   - Waking the worker costs battery.
   - Firefox applies a push quota, but pushes that show a notification are exempt.
   Source: https://developer.mozilla.org/en-US/docs/Web/API/Push_API

**If a hosted provider handles push (section 4),** steps 5 and 7 move to the provider. Its SDK usually supplies the subscribe call and a worker snippet you `importScripts` into `public/sw.js`. Steps 1 to 4 stay Cadence's job.

## 3. Permission-prompt UX and best practice

- **Never prompt on page load.** Ask only after a user gesture, and only when the user can see the benefit. Good moments are right after they click something that needs the capability, or after they opt into updates in your own dialog. Show an in-page **pre-prompt** first, and trigger the browser prompt only if they accept it. **Offer an alternative such as email** to anyone who declines. Source: web.dev, "Permissions best practices", https://web.dev/articles/permissions-best-practices (no date on page)
- **Denial is sticky.** Once a user blocks, the browser stops prompting and recovery requires deliberate user action. Check the state with `navigator.permissions.query()`. If it's blocked, show browser-specific steps to re-enable. Source: same web.dev article.
- **Numbers (Chrome desktop telemetry, quoted by web.dev):**
  - 77% of notification prompts were shown with no signal of user intent, and only 12% of those were accepted.
  - After a user interaction, acceptance rose to about 30%.
  Source: https://web.dev/articles/permissions-best-practices
- **Low-acceptance sites get the quiet UI.** Chrome automatically puts sites with very low accept rates into the quieter notification prompt, separately for mobile and desktop. CrUX publishes per-origin Accept/Deny/Ignore/Dismiss rates (`experimental.permission.notifications`, since the 202001 dataset). The published example is Google News: 82.3% accept, 4.8% deny. Source: Chrome for Developers, 2020-02-11, https://developer.chrome.com/blog/notification-permission-data-in-crux. Quiet-UI background, Chrome 80, Jan 2020: https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html
- **Gestures are enforced, not just recommended.** Firefox 72+ (desktop) and 79+ (Android) and Safari reject `subscribe()` without a user gesture (MDN BCD, WebKit posts above).
- **What this means for Cadence's UX:**
  - Put an "Enable notifications" control in the Notification Feed or in preferences.
  - Pre-prompt at a meaningful moment, such as after enrolling in a course or posting a question.
  - On iOS Safari outside a Home Screen app, show "Add to Home Screen" guidance instead of a button that can't work. Feature-detect `'PushManager' in window`.

## 4. Hosted notification providers: delivered for you, or bring your own?

| Provider | Native browser web push? | How it works | Source |
| --- | --- | --- | --- |
| **Knock** | **No** first-party web push | Its push providers are APNs, FCM, Expo, OneSignal and Amazon SNS. For browsers, Knock's own tutorial uses **FCM**: the Firebase JS SDK gets a token, which is stored as Knock channel data. Needs a Firebase project. | https://docs.knock.app/integrations/push/overview, https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm |
| **Novu** | **No** native VAPID channel | Push providers are FCM, Expo, APNs, OneSignal, Push Webhook, Pusher Beams and Pushpad. Browser push goes via **Pushpad** (a separate paid account plus its site SDK) or FCM/OneSignal/Beams. | https://docs.novu.co/platform/integrations/push, https://docs.novu.co/platform/integrations/push/pushpad |
| **Courier** | **No** native channel shown | Lists 12 push providers (APNs, FCM, Expo, OneSignal, Airship, SNS, Pusher Beams, Pusher, MagicBell, Pushbullet, Beamer, NowPush). Browser push is typically via FCM, per Courier's forum. | https://www.courier.com/docs/external-integrations/push/intro-to-push.md, https://forum.courier.com/t/can-courier-power-html5-push-notifications/71 |
| **MagicBell** | **Yes**, native Web Push channel | You configure the Web Push channel with a VAPID `public_key`/`private_key`, so **bring your own keys** (MagicBell offers a generator). Browser `PushSubscription`s are stored as tokens and MagicBell sends to them. A WebPush SDK handles subscribe and service-worker registration. | https://www.magicbell.com/docs/channels/web_push, https://magicbell.com/docs/libraries/webpush |
| **SuprSend** | **Yes**, native Web Push vendor | SuprSend **generates a VAPID key per account** (Vendors > Web Push > VAPID Keys). Your service worker `importScripts` SuprSend's hosted worker, and `registerPush()` prompts and registers the token. | https://docs.suprsend.com/docs/web-push-vendor-integration, https://docs.suprsend.com/docs/js-webpush |

Caveats:

- MagicBell's and SuprSend's details come partly from search snippets of their docs. Their SDK pages show differing API versions, so re-check before you implement.
- Free-tier coverage of the push channel, which map #2 makes a hard requirement, was **not** verified here. It belongs to the provider-choice ticket.
- Under every option, Cadence still owns the service worker file, the manifest, iOS Home Screen guidance and the permission UX.

## Caveats summary

- **Reach is opt-in and partial.**
  - On iPhone/iPad, only users who install Cadence to the Home Screen can get push. On iOS 26+ that is easier because any site opens as a web app, but it's still a manual step.
  - Elsewhere, cold prompts get about 12% acceptance, versus about 30% after a user action.
  - Push can't be the only channel for anything important.
- **Provider fit varies.** If Cadence picks Knock, Novu or Courier, web push means a second vendor (FCM/Firebase, Pushpad, OneSignal, ...). MagicBell and SuprSend handle it in one product.
- **Build cost is small** if Cadence does it itself: one static worker, a manifest, `web-push` on the server and a subscriptions table. If Cadence later also wants offline caching, React Router's lazy route discovery complicates the worker.
- **Not decided here:** whether Cadence uses push, and for which Notifications. That's the "Channels for each Notification" ticket.
