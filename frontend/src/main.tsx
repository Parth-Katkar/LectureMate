import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./AuthGate";
import "./styles.css";

// Attach the current bearer token to backend API calls. Browser CORS preflight
// OPTIONS requests intentionally remain unauthenticated; the backend lets CORS
// answer those while protecting the actual API request.
const originalFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isApi = /^https?:\/\/(127\.0\.0\.1|localhost):8000\/api\//.test(url);
  if (!isApi) return originalFetch(input, init);

  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "OPTIONS") return originalFetch(input, init);

  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  const token = localStorage.getItem("lecturemate:token");
  if (token && !url.includes("/api/auth/login") && !url.includes("/api/auth/register")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return originalFetch(input, { ...init, headers }).then((response) => {
    if (response.status === 401 &&
        !url.includes("/api/auth/login") &&
        !url.includes("/api/auth/register") &&
        !url.includes("/api/health")) {
      window.dispatchEvent(new CustomEvent("lecturemate:auth-expired"));
    }
    return response;
  });
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AuthGate /></React.StrictMode>,
);
