import express from "express";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { postgresStore } from "./store.ts";

const production = process.env.NODE_ENV === "production";
const demo =
  process.env.DEMO_MODE === "true" ||
  (!production && process.env.DEMO_MODE !== "false");
const db = process.env.DATABASE_URL
  ? postgresStore(process.env.DATABASE_URL)
  : openDatabase(process.env.DATABASE_PATH || "data/hostel360.sqlite", demo);
const app = createApp(db);

if (production) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, allowedHosts: [".onamp.dev"] },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () =>
  console.log(
    `Hostel360 listening on port ${port}${demo ? " · DEMO DATA" : ""}`,
  ),
);
