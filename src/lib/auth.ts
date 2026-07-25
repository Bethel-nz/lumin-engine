import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import * as schema from "../db/schema";
import { drizzle } from "drizzle-orm/d1";

export const getAuth = (db: D1Database) => {
  return betterAuth({
    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
    }),
    plugins: [
      apiKey({
        apiKeyHeaders: ["x-app-key", "x-api-key", "authorization"],
        defaultPrefix: "lum_",
        minimumPrefixLength: 4,
        maximumPrefixLength: 16,
      }),
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: "memory",
    },
    trustedOrigins: [
      "http://localhost:3000",
      "https://synaxis-app.vercel.app",
    ],
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
