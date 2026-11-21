# Knock branding on the free plan

Research for issue #11, "Knock branding on the free plan". Researched 2026-11-21.

**Question:** Cadence is on Knock's free plan and renders the in-app Notification Feed with its own custom UI built on Knock's feed hooks (`@knocklabs/react` `KnockFeedProvider` / `useKnockFeed`), not Knock's stock `NotificationFeed` / `NotificationFeedPopover`. Must Cadence still show "Powered by Knock" branding? If so, what exactly is required, and which plan removes it, at what price?

**Short answer: unclear on the strict question, but probably yes in spirit.**

- **Stated:** Removing Knock branding is a paid feature. The pricing page lists "Remove Knock branding" as **No** on Free and **Yes** on Starter (**$250/month + additional usage**) and Enterprise (custom pricing). That row sits in the **In-app feeds** section of the comparison table, right under "Bring your own components: Yes".
- **Stated:** Knock's API flags our feed with `branding_required: true`. The stock React and React Native feed components render a "Powered by Knock" footer whenever that flag is true.
- **Not stated anywhere:** No Knock doc, Terms of Service clause or changelog entry says a custom or headless UI must render the branding. Nothing specifies placement, wording or link for one either. The Terms of Service contain no branding or attribution obligation at all.
- **Implied:** Knock sends `branding_required` to the client and exports `useFeedSettings` from `@knocklabs/react-core`, so a custom UI can honour the flag. The "Remove Knock branding: No" row sits next to "Bring your own components", which suggests Knock expects branding on free-plan feeds whatever the UI. That is a reading of the page layout, not something Knock states.

If we want to be safe on the free plan, the closest thing to a spec is to copy what the stock component does (see §3).

---

## 1. Pricing page: what's stated

Source: https://knock.app/pricing (fetched 2026-11-21)

- Plans: Free "$0/month". Starter "$250/month + additional usage". Enterprise "Custom".
- Messages: Free "up to 10,000". Starter "50,000 then $0.005/ea".
- Starter card: "Everything in Free, plus... **Remove Knock branding** · Email client previews · Priority email support".
- The comparison table's **In-app feeds** section, verbatim apart from the column labels:

  | Row | Free | Starter | Enterprise |
  | --- | --- | --- | --- |
  | Pre-built components | Yes | Yes | Yes |
  | Bring your own components | Yes | Yes | Yes |
  | Remove Knock branding | No | Yes | Yes |

- There's a separate row, "Per-tenant branding", described as "Enable your customers to white-label your notifications with logo and brand colors". It's No / No / Yes, so Enterprise only. It's a different feature from removing the Knock label.
- The pricing page has no "Powered by Knock" text and no footnote about how the branding must appear.

## 2. Terms of Service: silent on branding

Source: https://knock.app/terms ("Last updated: March 4, 2026")

- There's no clause requiring Knock branding, attribution or a "Powered by" notice. The only mark-related text restricts *our* use of Knock's marks: "The Knock name and logos are trademarks and service marks of Knock" … "without our prior written permission in each instance."
- The Free plan comes up only in the Fees clause: "If your usage exceeds the amount set on our Free plan, you agree to pay the fees set forth on the Knock pricing page …".
- The Acceptable Use Policy (https://knock.app/acceptable-use-policy) also doesn't mention branding.
- **Unknown:** whether the Terms incorporate the pricing page's feature list by reference as a binding obligation. They point to it only for fees.

## 3. SDK source: what the stock component does

Source: https://github.com/knocklabs/javascript at commit `32c7a03` (2026-11-19)

- `packages/react-core/src/modules/feed/hooks/useFeedSettings.ts` calls `GET /v1/users/${knock.userId}/feeds/${feedClient.feedId}/settings` and reads `features.branding_required`. A comment there says leaving the settings unset on a bad response avoids "fabricating a default that would silently suppress branding when it is required." `useFeedSettings` is a **public export** of `@knocklabs/react-core` (`packages/react-core/src/index.ts`).
- `packages/react/src/modules/feed/components/NotificationFeed/NotificationFeed.tsx`:

  ```tsx
  const poweredByKnockUrl =
    "https://knock.app?utm_source=powered-by-knock&utm_medium=referral&utm_campaign=knock-branding-feed";
  ...
  {settings?.features?.branding_required && (
    <div className="rnf-notification-feed__knock-branding">
      <a href={poweredByKnockUrl} target="_blank">
        {t("poweredBy") || "Powered by Knock"}
      </a>
    </div>
  )}
  ```

  - **Placement:** a footer at the bottom of the feed container, below the item list.
  - **Wording:** "Powered by Knock". The text goes through i18n (`poweredBy`), so the stock component lets you translate it.
  - **Link:** `https://knock.app` with the UTM parameters above, opening in a new tab.
  - **Style** (`styles.css`): centred, small grey text, 6px padding, thin top border.
- The React Native `NotificationFeed.tsx` shows a `<PoweredByKnockIcon />` under the same `branding_required` condition.
- Everything above describes what Knock's own components do. None of it is a requirement Knock has written down for third-party UIs.

## 4. Docs: silent on custom UIs and on `branding_required`

- The headless feed guide (https://docs.knock.app/in-app-ui/react/headless/feed) covers building a fully custom feed with `KnockFeedProvider` / `useKnockFeed`. It says **nothing** about branding, `branding_required`, `useFeedSettings` or plan requirements.
- The feeds overview (https://docs.knock.app/in-app-ui/feeds/overview) also says **nothing** about branding.
- The full docs corpus (https://docs.knock.app/llms-full.txt, fetched 2026-11-21) contains **zero** occurrences of `branding_required`. The only "Powered by Knock" branding text in it is an email FAQ on the "Testing & debugging templates" page: "If you're seeing the 'Powered by Knock' branding appear multiple times in your email notifications, it's because you're double wrapping your email template in HTML." So free-plan branding also shows up in **email** layouts, not only in the feed.
- API reference (https://docs.knock.app/api-reference/users/feeds/get_settings): "`GET /v1/users/{user_id}/feeds/{id}/settings`. Returns the feed settings for a user." `branding_required` appears only in the example response (`true`) and is never described.
- The changelog (https://knock.app/changelog) has no entry about feed branding or `branding_required`. The branding entries it does have cover template branding settings (2021-12-02) and per-tenant branding (2022-07-14).

## 5. Stated vs implied vs unknown

| | Finding |
| --- | --- |
| **Stated** | Free plan: "Remove Knock branding: No", listed under In-app feeds. Starter ($250/mo + usage) and Enterprise (custom) remove it. |
| **Stated** | Our feed settings return `branding_required: true`. The stock components render a "Powered by Knock" footer link when it's true. |
| **Stated** | The Terms of Service contain no branding or attribution clause. |
| **Implied** | Knock expects branding on free-plan feeds whatever the UI: the branding row sits next to "Bring your own components", and the flag and hook are public. |
| **Unknown** | Whether a custom UI that leaves out the branding breaches anything enforceable, and whether Knock enforces it at all (for example, detection or account action). |
| **Unknown** | Any required placement, wording or link for custom UIs. Nothing is documented, and the stock footer is the only reference. |
| **Unknown** | Whether "Remove Knock branding" also removes the email-layout "Powered by Knock" (probably, but not stated per channel). |

**Who can settle it:** only Knock (support or sales) can say whether custom feeds on Free must show the branding. Asking them is cheap, and it's the only way to turn "implied" into "stated".
