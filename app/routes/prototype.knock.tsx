// PROTOTYPE — throwaway. Lives only on the `prototype/knock` branch; never merge.
// Answers "Try Knock in Cadence" (dejongyeong/ai-hero-sw-factories#9):
// does Knock's Feed, live updates, preferences, sandbox mode and Postmark
// email hold up inside Cadence? One panel per pass/fail check.
//
// Run: npm run dev, pick a user in the DevUI panel, open /prototype/knock.
// Needs a committed workflow in Knock's Development env (key below) with an
// in-app Feed step and an email step.
import { useRef, useState } from "react";
import { data, useFetcher, useSearchParams } from "react-router";
import { Knock, signUserToken } from "@knocklabs/node";
import {
  KnockProvider,
  KnockFeedProvider,
  NotificationIconButton,
  NotificationFeedPopover,
  NotificationFeed,
} from "@knocklabs/react";
import "@knocklabs/react/dist/index.css";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/prototype.knock";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { users } from "~/db/schema";

// React Router doesn't put .env into process.env; load it for the prototype.
try {
  process.loadEnvFile(".env");
} catch {}

const WORKFLOW = process.env.KNOCK_PROTOTYPE_WORKFLOW ?? "prototype-knock";

function knock() {
  return new Knock({ apiKey: process.env.KNOCK_SECRET_API_KEY });
}

async function currentUser(request: Request) {
  const id = await getCurrentUserId(request);
  if (!id) throw data("Select a user from the DevUI panel.", { status: 401 });
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw data("User not found.", { status: 404 });
  return user;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await currentUser(request);
  const knockId = `cadence-${user.id}`;
  // Identify (upsert) the user so Knock has a name and email to send to.
  await knock().users.update(knockId, { name: user.name, email: user.email });
  const userToken = await signUserToken(knockId, {
    signingKey: process.env.KNOCK_SIGNING_KEY,
    expiresInSeconds: 3600,
  });
  const preferences = await knock()
    .users.getPreferences(knockId, "default")
    .catch((e: Error) => ({ error: e.message }));
  return {
    user: { name: user.name, email: user.email, knockId },
    userToken,
    publicKey: process.env.KNOCK_PUBLIC_API_KEY!,
    feedId: process.env.KNOCK_FEED_CHANNEL_ID!,
    workflow: WORKFLOW,
    preferences,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await currentUser(request);
  const knockId = `cadence-${user.id}`;
  const form = await request.formData();
  const intent = form.get("intent");
  const startedAt = new Date().toISOString();
  try {
    if (intent === "trigger") {
      const sandbox = form.get("sandbox") === "on";
      const emailOverride = String(form.get("email") ?? "").trim();
      if (emailOverride) {
        await knock().users.update(knockId, { email: emailOverride });
      }
      const result = await knock().workflows.trigger(WORKFLOW, {
        recipients: [knockId],
        data: { message: `Prototype ping at ${startedAt}` },
        ...(sandbox ? { settings: { sandbox_mode: true } } : {}),
      } as never);
      return { intent, startedAt, sandbox, emailOverride, result };
    }
    if (intent === "setPreference") {
      const enabled = form.get("enabled") === "true";
      const result = await knock().users.setPreferences(knockId, "default", {
        __persistence_strategy__: "merge",
        workflows: { [WORKFLOW]: enabled },
      } as never);
      return { intent, startedAt, enabled, result };
    }
    if (intent === "messages") {
      const page = await knock().users.listMessages(knockId, {
        page_size: 10,
      } as never);
      const result = page.items.map((m) => ({
        id: m.id,
        channel_id: m.channel_id,
        status: m.status,
        inserted_at: m.inserted_at,
      }));
      return { intent, startedAt, result };
    }
  } catch (e) {
    return { intent, startedAt, error: (e as Error).message };
  }
  return { intent, error: "unknown intent" };
}

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  const { user, userToken, publicKey, feedId, workflow, preferences } =
    loaderData;
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
        PROTOTYPE: Try Knock in Cadence. Signed in to Knock as{" "}
        <code>{user.knockId}</code> ({user.name}). Workflow:{" "}
        <code>{workflow}</code>
      </div>

      <KnockProvider apiKey={publicKey} user={{ id: user.knockId }} userToken={userToken}>
        <KnockFeedProvider feedId={feedId}>
          <section className="space-y-2">
            <h2 className="font-semibold">
              Checks 1 + 2: Feed mounts (SSR) and updates live
            </h2>
            <div className="flex items-center gap-3">
              <NotificationIconButton
                ref={buttonRef}
                onClick={() => setOpen(!open)}
              />
              <span className="text-sm text-muted-foreground">
                Bell + popover. Keep it open, press Trigger below, watch it
                arrive without reload.
              </span>
            </div>
            <NotificationFeedPopover
              buttonRef={buttonRef as React.RefObject<HTMLElement>}
              isVisible={open}
              onClose={() => setOpen(false)}
            />
            {params.get("inline") !== "off" && (
              <div className="h-80 overflow-hidden rounded border">
                <NotificationFeed />
              </div>
            )}
          </section>
        </KnockFeedProvider>
      </KnockProvider>

      <section className="space-y-2">
        <h2 className="font-semibold">Trigger (checks 2, 4, 5)</h2>
        <fetcher.Form method="post" className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="intent" value="trigger" />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" name="sandbox" /> sandbox_mode on this run
          </label>
          <input
            name="email"
            placeholder="override email (for Postmark check)"
            className="rounded border px-2 py-1 text-sm"
          />
          <button className="rounded bg-black px-3 py-1 text-white">
            Trigger
          </button>
        </fetcher.Form>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Check 3: preferences</h2>
        <div className="flex gap-2">
          {[false, true].map((enabled) => (
            <fetcher.Form method="post" key={String(enabled)}>
              <input type="hidden" name="intent" value="setPreference" />
              <input type="hidden" name="enabled" value={String(enabled)} />
              <button className="rounded border px-3 py-1">
                {enabled ? "Turn workflow on" : "Turn workflow off"}
              </button>
            </fetcher.Form>
          ))}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="messages" />
            <button className="rounded border px-3 py-1">
              List my last 10 messages
            </button>
          </fetcher.Form>
        </div>
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
          preferences (at page load): {JSON.stringify(preferences, null, 2)}
        </pre>
      </section>

      <section>
        <h2 className="font-semibold">Last action result</h2>
        <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs">
          {fetcher.state !== "idle"
            ? "…"
            : JSON.stringify(fetcher.data ?? null, null, 2)}
        </pre>
      </section>
    </div>
  );
}
