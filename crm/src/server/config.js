import { z } from "zod";

const Config = z.object({
  PUBLIC_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  TOKEN_KEY: z.base64().refine((s) => atob(s).length === 32, "32 bytes, base64"),
  CONSENT_SECRET: z.string().min(32),
  // The Workers rate-limit binding (wrangler.jsonc `ratelimits`); without it the open endpoints would run unthrottled.
  AUTH_LIMIT: z.custom((binding) => typeof binding?.limit === "function", "rate-limit binding"),
  ALLOWED_EMAILS: z.string().transform((s) => s.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)).pipe(z.array(z.email()).min(1)),
});

/** Fail closed: a missing or malformed secret or binding stops every request instead of running half-configured. */
export function readConfig(env) {
  const parsed = Config.safeParse(env);
  if (!parsed.success) throw new Error("Invalid configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  return parsed.data;
}
