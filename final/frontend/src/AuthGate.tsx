import { useEffect, useState, type FormEvent } from "react";
import App from "./App";
import "./auth.css";

const API_BASE = "http://127.0.0.1:8000";

type Session = { access_token: string; token_type: string; user: { id: number; email: string } };

async function authRequest(mode: "login" | "register", email: string, password: string): Promise<Session> {
  const response = await fetch(`${API_BASE}/api/auth/${mode}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Authentication failed.");
  return data as Session;
}

export default function AuthGate() {
  const [token, setToken] = useState(() => localStorage.getItem("lecturemate:token") || "");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const logout = () => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("lecturemate:")) localStorage.removeItem(key);
      }
      setToken("");
      setError("Your session ended. Please sign in again.");
    };
    window.addEventListener("lecturemate:logout", logout);
    window.addEventListener("lecturemate:auth-expired", logout);
    return () => {
      window.removeEventListener("lecturemate:logout", logout);
      window.removeEventListener("lecturemate:auth-expired", logout);
    };
  }, []);

  if (token) return <App />;

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const session = await authRequest(mode, email.trim(), password);
      // These legacy client-side caches were not account-scoped. Clear them on account switch;
      // durable lecture content is loaded from the authenticated backend.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("lecturemate:") && key !== "lecturemate:token" && key !== "lecturemate:user") localStorage.removeItem(key);
      }
      localStorage.setItem("lecturemate:token", session.access_token);
      localStorage.setItem("lecturemate:user", JSON.stringify(session.user));
      setToken(session.access_token);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not sign in."); }
    finally { setBusy(false); }
  }

  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <div className="auth-mark">LM</div><h1>Welcome to LectureMate</h1>
    <p>{mode === "login" ? "Sign in to open your private lecture library." : "Create an account for your private lecture library."}</p>
    <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <div className="auth-error" role="alert">{error}</div>}
    <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
    <button className="auth-switch" type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "New to LectureMate? Create an account" : "Already have an account? Sign in"}</button>
    <small>Passwords are stored as salted PBKDF2 hashes. Keep your local database and uploads backed up.</small>
  </form></main>;
}
