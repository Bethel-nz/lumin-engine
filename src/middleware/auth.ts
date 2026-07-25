import type { Context, Next } from "hono";
import type { AppVariables, EnvBindings } from "../types";
import { getAuth } from "../lib/auth";

export const requireApiKey = async (
  c: Context<{ Bindings: EnvBindings; Variables: AppVariables }>,
  next: Next
) => {
  const appKey = c.req.header("X-App-Key");
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("X-Api-Key");

  const apiKey = appKey || xApiKey || authHeader?.replace(/^Bearer\s+/i, "");

  if (!apiKey) {
    return c.json({ error: "Unauthorized: Missing API key" }, 401);
  }

  try {
    const auth = getAuth(c.env.DB);
    const result = await auth.api.verifyApiKey({
      body: { key: apiKey },
    });

    if (!result.valid) {
      return c.json({ error: "Unauthorized: Invalid API key" }, 401);
    }

    c.set("userId", result.key?.referenceId || null);
    c.set("apiKeyId", result.key?.id || null);

    await next();
  } catch {
    return c.json({ error: "Unauthorized: Invalid API key" }, 401);
  }
};
