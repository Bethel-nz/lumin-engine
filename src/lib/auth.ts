import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import type { EnvBindings } from "../types";

export const getTrustedOrigins = (value?: string): string[] =>
  (value ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const getAuth = (db: D1Database, env: EnvBindings) => {
  return betterAuth({
    appName: "Lumin",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
    }),
    emailAndPassword: {
      enabled: true,
    },
    user: {
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => {
          await db.batch([
            db.prepare("DELETE FROM apikey WHERE reference_id = ?").bind(user.id),
            db.prepare("DELETE FROM catalog_outbox WHERE tenant_id = ?").bind(user.id),
            db.prepare("DELETE FROM tenants WHERE id = ?").bind(user.id),
          ]);
        },
      },
    },
    plugins: [
      apiKey({
        apiKeyHeaders: [
          "x-lumin-key",
          "x-app-key",
          "x-api-key",
          "authorization",
        ],
        defaultPrefix: "lum_",
        minimumPrefixLength: 4,
        maximumPrefixLength: 16,
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: 1_000,
        },
      }),
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: "memory",
    },
    trustedOrigins: getTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS),
  });
};

export const getOrCreateAdminUser = async (db: D1Database) => {
  const existingUsers = await db
    .prepare("SELECT id FROM `user` LIMIT 1")
    .all<{ id: string }>();

  if (existingUsers.results && existingUsers.results.length > 0) {
    return existingUsers.results[0].id;
  }

  const userId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT INTO \`user\` (id, name, email, email_verified, image, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, "Admin", "admin@lumin.local", 0, null, now, now)
    .run();

  return userId;
};
