/**
 * Pi coding agent extension for toilgate.
 *
 * Install globally: copy to ~/.pi/agent/extensions/toilgate.ts
 * Test locally:     pi -e ./toilgate.ts
 *
 * /login → toilgate  (Google OAuth via browser or device code)
 *
 * Requires TOILGATE_URL to be set before starting Pi:
 *   export TOILGATE_URL=https://your-toilgate-server.example.com
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER_ID = "toilgate";
const CLIENT_ID = "opencode";
const REDIRECT_URI = "http://127.0.0.1:14641/callback";
const REFRESH_SKEW_MS = 60_000;
const USER_AGENT = "Pi/1.0 (pi-coding-agent; toilgate-extension)";

function resolveIssuer(): string | undefined {
  const raw = process.env["TOILGATE_URL"];
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

function isRemoteSession(): boolean {
  if (process.env["SSH_CONNECTION"] || process.env["SSH_TTY"] || process.env["SSH_CLIENT"]) {
    return true;
  }
  return process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"];
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

type TokenSet = { access: string; refresh: string; expires: number };

async function tokenGrant(
  issuer: string,
  form: Record<string, string>
): Promise<TokenSet | { error: string }> {
  const res = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body["error"] === "string") return { error: body["error"] as string };
  if (!res.ok || typeof body["access_token"] !== "string") {
    return { error: `token endpoint returned ${res.status}` };
  }
  return {
    access: body["access_token"] as string,
    refresh: body["refresh_token"] as string,
    expires: Date.now() + Number(body["expires_in"] ?? 3600) * 1000,
  };
}

async function browserLogin(
  issuer: string,
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  callbacks.onAuth({ url: `${issuer}/authorize?${params}` });

  const raw = await callbacks.onPrompt({
    message:
      "Complete the Google sign-in. The browser will redirect to a localhost URL " +
      "(which will show a connection error — that is expected).\n" +
      "Copy the full URL from your browser's address bar and paste it here:",
  });

  let code: string | null = null;
  try {
    const u = new URL(raw.trim());
    if (u.searchParams.get("state") !== state) {
      throw new Error("state mismatch — possible CSRF, please try again");
    }
    code = u.searchParams.get("code");
  } catch (e: any) {
    throw new Error(`could not parse redirect URL: ${e.message}`);
  }
  if (!code) throw new Error("no authorization code found in the redirect URL");

  const tokens = await tokenGrant(issuer, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  if ("error" in tokens) throw new Error(`toilgate login failed: ${tokens.error}`);
  return { refresh: tokens.refresh, access: tokens.access, expires: tokens.expires };
}

async function deviceCodeLogin(
  issuer: string,
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  const res = await fetch(`${issuer}/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
  });
  const dc = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  if (typeof (callbacks as any).onDeviceCode === "function") {
    (callbacks as any).onDeviceCode({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri_complete,
      intervalSeconds: dc.interval ?? 5,
      expiresInSeconds: dc.expires_in,
    });
  } else {
    callbacks.onAuth({ url: dc.verification_uri_complete });
    await callbacks.onPrompt({
      message: `Open the URL in any browser, confirm code ${dc.user_code}, sign in with Google, then press Enter here.`,
    });
  }

  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000));
    const tokens = await tokenGrant(issuer, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: dc.device_code,
    });
    if ("error" in tokens) {
      if (tokens.error === "authorization_pending") continue;
      throw new Error(`toilgate login failed: ${tokens.error}`);
    }
    return { refresh: tokens.refresh, access: tokens.access, expires: tokens.expires };
  }
  throw new Error("toilgate device code expired");
}

export default async function (pi: ExtensionAPI) {
  const issuer = resolveIssuer();
  if (!issuer) {
    console.warn("toilgate: TOILGATE_URL is not set — provider not registered");
    return;
  }

  // Discover models dynamically from toilgate's live list
  let models: any[] = [];
  try {
    const res = await fetch(`${issuer}/models.json`, {
      signal: AbortSignal.timeout(3000),
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.ok) {
      const body = (await res.json()) as { models?: string[] };
      models = (body.models ?? []).map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 16000,
      }));
    }
  } catch {
    // toilgate unreachable at startup — provider registered without models
  }

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: `${issuer}/v1`,
    apiKey: "toilgate",
    authHeader: true,
    api: "openai-completions",
    headers: { "User-Agent": USER_AGENT },
    models,
    oauth: {
      name: "toilgate (Google sign-in)",

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        // SSH / headless sessions can't receive the loopback browser redirect,
        // so default to device code there.
        if (isRemoteSession()) {
          return deviceCodeLogin(issuer, callbacks);
        }
        return browserLogin(issuer, callbacks);
      },

      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh) {
          throw new Error("no refresh token — run /login toilgate");
        }
        if (credentials.expires && credentials.expires - REFRESH_SKEW_MS > Date.now()) {
          return credentials;
        }
        const tokens = await tokenGrant(issuer, {
          grant_type: "refresh_token",
          refresh_token: credentials.refresh,
        });
        if ("error" in tokens) {
          throw new Error(`toilgate token refresh failed (${tokens.error}) — run /login`);
        }
        return { refresh: tokens.refresh, access: tokens.access, expires: tokens.expires };
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });
}
