import { createApp } from "../server/app.js";
import { postgresStore } from "../server/store.js";

if (
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error(
    "Supabase database and Auth must be configured before deployment.",
  );
}
export default createApp(postgresStore(process.env.DATABASE_URL));
