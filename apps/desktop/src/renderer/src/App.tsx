import { AuthState } from "@chiefbot/contracts";
import { useEffect, useState } from "react";

// Sign-in screen: GitHub device code while waiting, then the user and their Copilot plan.
export function App() {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    const unsubscribe = window.chiefbot.auth.onChange((next) => setState(AuthState.parse(next)));
    void window.chiefbot.auth.get().then((next) => setState(AuthState.parse(next)));
    return unsubscribe;
  }, []);

  return (
    <main className="screen">
      <h1>Chiefbot</h1>
      {state && <AuthPanel state={state} />}
    </main>
  );
}

function AuthPanel({ state }: { state: AuthState }) {
  const { signIn, signOut } = window.chiefbot.auth;
  switch (state.status) {
    case "signed-out":
      return <button onClick={() => void signIn()}>Sign in with GitHub</button>;
    case "waiting-for-code":
      return (
        <div className="card">
          <p>Enter this code on GitHub:</p>
          <code className="code">{state.userCode}</code>
          <a href={state.verificationUri} target="_blank" rel="noreferrer">
            Open {state.verificationUri}
          </a>
        </div>
      );
    case "signed-in": {
      const { login, copilotPlan } = state.user;
      return (
        <div className="card">
          <p>
            Signed in as <strong>{login}</strong>
          </p>
          <p>Copilot plan: {copilotPlan ? `${copilotPlan.plan} (${copilotPlan.sku})` : "none"}</p>
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      );
    }
    case "error":
      return (
        <div className="card">
          <p className="error">{state.message}</p>
          <button onClick={() => void signIn()}>Try again</button>
        </div>
      );
  }
}
