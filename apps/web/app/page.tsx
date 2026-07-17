import { redirect } from "next/navigation";

/**
 * Entry point. The middleware has already decided whether there is a session, so
 * "/" only ever needs to hand off: signed in → the dashboard, otherwise the
 * middleware bounces this redirect to /login.
 *
 * (The Sprint-0 API health card that lived here has served its purpose — the
 * dashboard now shows API connectivity alongside things a human actually cares
 * about.)
 */
export default function HomePage() {
  redirect("/dashboard");
}
