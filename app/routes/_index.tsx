import { Navigate, redirect } from "react-router";

/**
 * The home route ("/") is the Dashboard. Chat lives at "/chat".
 *
 * The server loader issues a 302 when it runs. But the production build can
 * serve "/" as a prerendered/SPA shell without executing the loader (curl to
 * prod returns 200, not 302), so we ALSO render a client-side <Navigate> as a
 * belt-and-suspenders fallback — that guarantees the browser lands on the
 * dashboard whether or not the loader fired on the server.
 */
export function loader() {
  return redirect("/dashboard");
}

export default function IndexRedirect() {
  return <Navigate to="/dashboard" replace />;
}
