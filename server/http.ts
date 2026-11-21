import type { Response } from "express";
import { createClient } from "@supabase/supabase-js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new ApiError(status, message);
}
export const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
export const now = () => new Date().toISOString();
export const validDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
export const validMonth = (v: unknown): v is string =>
  typeof v === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(v);
export const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0 && Number(v) < 1_000_000_000;
export const text = (v: unknown, max = 120): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
export const me = (res: Response) =>
  res.locals.user as {
    id: number;
    name: string;
    email: string;
    role: string;
    student_id: number | null;
    auth_id: string | null;
    must_change_password: number;
  };
export const staff = (res: Response) =>
  ensure(
    ["Admin", "Manager"].includes(me(res).role),
    "Staff access required.",
    403,
  );
export const admin = (res: Response) =>
  ensure(me(res).role === "Admin", "Only Admin can perform this action.", 403);
export const categories = ["Mess", "Fund", "Management", "Establishment"];
export function supabase() {
  ensure(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Supabase is not configured for this workspace.",
    503,
  );
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
