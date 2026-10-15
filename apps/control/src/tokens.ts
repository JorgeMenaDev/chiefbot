import type { BrokeredGitHubToken, GitHubTokens, UserId } from "@chiefbot/contracts";
import type { SecretStore } from "./secrets/secretStore.ts";
import type { openStore } from "./store.ts";

// The SDK asks for a new token once an hour or less is left, so the broker hands
// out only tokens with more than two hours left and refreshes before that.
const refreshWhenLeftMs = 2 * 3600_000;

export type TokenBrokerOptions = {
  store: ReturnType<typeof openStore>;
  secrets: SecretStore;
  // GitHub's refresh grant: the new pair, or null when GitHub refuses the refresh token.
  refresh: (refreshToken: string) => Promise<GitHubTokens | null>;
  // Called after a user's GitHub sign-in is stored or lost.
  onChange: (userId: UserId) => void;
};

// Control's GitHub token broker. The refresh token lives only in the SecretStore;
// SQLite holds the short-lived access token and both expiry times. Every change
// to one user's tokens (sign-in, refresh, revoke) runs one at a time, since a
// refresh invalidates the pair it used: concurrent requests share one refresh.
export function tokenBroker({ store, secrets, refresh, onChange }: TokenBrokerOptions) {
  const queues = new Map<UserId, Promise<unknown>>();
  const refreshTokenName = (userId: UserId) => `github-refresh-token-${userId}`;

  // Runs `change` once every earlier change for the same user has settled.
  function serialized<T>(userId: UserId, change: () => Promise<T>): Promise<T> {
    const result = (queues.get(userId) ?? Promise.resolve()).then(change);
    const settled = result.catch(() => {});
    queues.set(userId, settled);
    void settled.then(() => {
      if (queues.get(userId) === settled) queues.delete(userId);
    });
    return result;
  }

  async function save(userId: UserId, tokens: GitHubTokens) {
    // The secret first: if control dies in between, the old access token is about
    // to expire anyway and the next request refreshes with the new refresh token.
    await secrets.put(refreshTokenName(userId), tokens.refreshToken);
    store.setGitHubAccess(userId, tokens);
  }

  async function forget(userId: UserId) {
    store.deleteGitHubAccess(userId);
    await secrets.delete(refreshTokenName(userId));
    onChange(userId);
  }

  // The stored access token, unless there is none or it is too close to expiry.
  function usable(userId: UserId): BrokeredGitHubToken | null {
    const access = store.githubAccess(userId);
    if (!access || access.accessTokenExpiresAt - Date.now() <= refreshWhenLeftMs) return null;
    return { accessToken: access.accessToken, expiresAt: access.accessTokenExpiresAt };
  }

  return {
    // Stores the pair a sign-in brought, replacing any earlier one.
    signIn: (userId: UserId, tokens: GitHubTokens) =>
      serialized(userId, async () => {
        await save(userId, tokens);
        onChange(userId);
      }),

    // Forgets the user's GitHub sign-in: their bots get no token until they sign in again.
    revoke: (userId: UserId) => serialized(userId, () => forget(userId)),

    // A token for the user's bots, refreshed first when needed. Null when control
    // has no usable sign-in (none stored, or GitHub refused the refresh token).
    async accessToken(userId: UserId): Promise<BrokeredGitHubToken | null> {
      const ready = usable(userId);
      if (ready || !store.githubAccess(userId)) return ready;
      return serialized(userId, async () => {
        // An earlier request may have refreshed, or revoked, while this one waited.
        const access = store.githubAccess(userId);
        if (!access) return null;
        const refreshed = usable(userId);
        if (refreshed) return refreshed;
        const refreshToken = access.refreshTokenExpiresAt > Date.now() ? await secrets.get(refreshTokenName(userId)) : null;
        const tokens = refreshToken ? await refresh(refreshToken) : null;
        if (!tokens) {
          await forget(userId);
          return null;
        }
        await save(userId, tokens);
        return { accessToken: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt };
      });
    },
  };
}
