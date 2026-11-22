import { signUserToken } from "@knocklabs/node";
import type { KnockFeedSession } from "~/lib/notifications";

// ─── Knock configuration ───
// Knock sends every Notification (ADR 0013). Its keys come from .env, which
// `react-router dev` does not load into process.env, so it is loaded here the
// first time a key is needed. Every key is optional: with none set, triggers
// go to .outbox/ and the Notification Feed shows its empty state.

let envLoaded = false;

function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: run without Knock.
  }
}

function read(name: string) {
  loadEnv();
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function knockConfig() {
  return {
    secretKey: read("KNOCK_SECRET_API_KEY"),
    publicKey: read("KNOCK_PUBLIC_API_KEY"),
    signingKey: read("KNOCK_SIGNING_KEY"),
    feedChannelId: read("KNOCK_FEED_CHANNEL_ID"),
  };
}

/** How a Cadence user is identified in Knock. */
export function knockUserId(userId: number) {
  return `cadence-${userId}`;
}

const USER_TOKEN_SECONDS = 60 * 60;

/**
 * Signs a 1-hour Knock user token for the Feed. Signing is local and makes no
 * API call. Returns null when Knock isn't configured, so the Feed renders
 * empty instead of erroring.
 */
export async function knockFeedSession(
  userId: number
): Promise<KnockFeedSession | null> {
  const { publicKey, signingKey, feedChannelId } = knockConfig();
  if (!publicKey || !signingKey || !feedChannelId) return null;

  const knockId = knockUserId(userId);
  try {
    const userToken = await signUserToken(knockId, {
      signingKey,
      expiresInSeconds: USER_TOKEN_SECONDS,
    });
    return { userId: knockId, userToken, publicKey, feedChannelId };
  } catch (error) {
    console.error("Could not sign a Knock user token", error);
    return null;
  }
}
