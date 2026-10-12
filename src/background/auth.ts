/**
 * Google sign-in with chrome.identity.launchWebAuthFlow (works for any number
 * of Google accounts, and in Chromium browsers without Chrome sign-in).
 * OAuth token flow: access tokens last an hour and are renewed silently with
 * prompt=none for the same account; when Google wants the user back
 * (signed out, access revoked) the account is marked "needs sign-in".
 */
import type { Account } from "../shared/messages";
import { getSettings, setAccountStatus, updateSettings } from "./settings";

const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

interface Token {
  token: string;
  exp: number;
}

export class AuthError extends Error {}

async function flow(o: { interactive: boolean; loginHint?: string; prompt?: string }): Promise<Token> {
  const { clientId } = await getSettings();
  if (!clientId) throw new AuthError("Set the Google OAuth client ID in Settings first.");
  const state = crypto.randomUUID();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: "token",
    scope: SCOPES.join(" "),
    include_granted_scopes: "true",
    state,
  });
  if (o.loginHint) p.set("login_hint", o.loginHint);
  if (o.prompt) p.set("prompt", o.prompt);
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`,
      interactive: o.interactive,
      ...(o.interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15_000 }),
    });
  } catch (e) {
    throw new AuthError(e instanceof Error ? e.message : String(e));
  }
  if (!redirect) throw new AuthError("Sign-in was cancelled.");
  const r = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (r.get("error")) throw new AuthError(`Google sign-in: ${r.get("error")}`);
  if (r.get("state") !== state) throw new AuthError("Google sign-in: state mismatch.");
  if (!(r.get("scope") ?? "").split(" ").includes(DRIVE_SCOPE))
    throw new AuthError("Google Drive access was not granted. Add the account again and allow Drive access.");
  return { token: r.get("access_token") ?? "", exp: Date.now() + Number(r.get("expires_in") ?? 3600) * 1000 };
}

async function userInfo(token: string): Promise<Account> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new AuthError(`Google userinfo: ${res.status}`);
  const u = (await res.json()) as { sub: string; email: string; name?: string; picture?: string };
  return { sub: u.sub, email: u.email, name: u.name, picture: u.picture };
}

const tokenKey = (sub: string) => `token:${sub}`;

async function saveToken(sub: string, t: Token): Promise<void> {
  await chrome.storage.session.set({ [tokenKey(sub)]: t });
  await setAccountStatus(sub, { needsAuth: false });
}

/** Interactive: pick (or add) a Google account and grant Drive access. */
export async function addAccount(): Promise<Account> {
  const t = await flow({ interactive: true, prompt: "select_account" });
  const account = await userInfo(t.token);
  await saveToken(account.sub, t);
  await updateSettings((s) => ({
    accounts: [...s.accounts.filter((a) => a.sub !== account.sub), account],
    active: s.active ?? account.sub,
  }));
  return account;
}

/** Interactive sign-in again for one account (after "needs sign-in"). */
export async function reconnect(account: Account): Promise<void> {
  const t = await flow({ interactive: true, loginHint: account.email });
  const who = await userInfo(t.token);
  if (who.sub !== account.sub) throw new AuthError(`That was ${who.email}, not ${account.email}.`);
  await saveToken(account.sub, t);
}

const inflight = new Map<string, Promise<string>>();

/** A valid access token for the account; `stale` is one Drive just rejected. */
export function tokenFor(account: Account, stale?: string): Promise<string> {
  const running = inflight.get(account.sub);
  if (running) return running;
  const p = (async () => {
    const cached = (await chrome.storage.session.get(tokenKey(account.sub)))[tokenKey(account.sub)] as Token | undefined;
    if (cached && cached.token !== stale && cached.exp > Date.now() + 60_000) return cached.token;
    try {
      const t = await flow({ interactive: false, loginHint: account.email, prompt: "none" });
      if ((await userInfo(t.token)).sub !== account.sub) throw new AuthError("Signed in as a different account.");
      await saveToken(account.sub, t);
      return t.token;
    } catch (e) {
      await setAccountStatus(account.sub, { needsAuth: true });
      throw e instanceof AuthError ? e : new AuthError(String(e));
    }
  })().finally(() => inflight.delete(account.sub));
  inflight.set(account.sub, p);
  return p;
}

/** Drops this browser's token. Not revoked: that would cut off the account's other browsers too. */
export async function signOut(sub: string): Promise<void> {
  await chrome.storage.session.remove(tokenKey(sub));
}
