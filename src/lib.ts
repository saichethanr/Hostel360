export type Student = {
  id: number;
  code: string;
  roll: string;
  name: string;
  department: string;
  year: number;
  room: string;
  phone: string;
  guardian: string;
  admission_type: string;
  status: string;
  joined: string;
  course: string;
  academic_year: string;
  address: string;
  guardian_phone: string;
  exited: string | null;
  exit_reason: string;
};
export type Demand = {
  id: number;
  student_id: number;
  name: string;
  code: string;
  department: string;
  category: string;
  period: string;
  description: string;
  amount: number;
  collected: number;
  balance: number;
  days: number;
  rate: number;
  adjustment: number;
  adjustment_reason: string;
};
export type Payment = {
  id: number;
  student_id: number;
  name: string;
  code: string;
  amount: number;
  date: string;
  mode: string;
  refunded_amount: number;
  reference: string;
  category: string;
  receipt: string;
  received_name: string;
  reversed_at: string | null;
  reversal_reason: string;
};
export type Receipt = Payment & {
  hostel: string;
  gateway?: { charged: number; refunded_before_receipt: number };
  allocations: { period: string; description: string; amount: number }[];
};
export type Attendance = { student_id: number; status: string };
export type Preview = {
  period: string;
  rate: number;
  total: number;
  finalized: boolean;
  closed: boolean;
  rows: {
    student_id: number;
    name: string;
    code: string;
    days: number;
    expected: number;
    missing: number;
    rate: number;
    amount: number;
  }[];
};
export type Community = { id: number; code: string; name: string };
export type Membership = {
  community: Community;
  name: string;
  role: string;
  status: string;
  reason: string;
};
export type Workspace = {
  community?: Community;
  pending_members?: number;
  user: {
    id: number;
    name: string;
    role: string;
    email: string;
    student_id: number | null;
    must_change_password: number;
  };
  settings: Record<string, string>;
  today: string;
  students: Student[];
  demands: Demand[];
  payments: Payment[];
  attendance: Attendance[];
  audit: {
    id: number;
    actor: string;
    action: string;
    detail: string;
    created_at: string;
  }[];
};
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export const communityCode = () =>
  new URLSearchParams(window.location.search).get("community") ||
  sessionStorage.getItem("h360_community") ||
  "";
export function selectCommunity(code: string) {
  sessionStorage.setItem("h360_community", code);
  const url = new URL(window.location.href);
  url.searchParams.set("community", code);
  window.history.replaceState(null, "", url);
}
export function leaveCommunity() {
  sessionStorage.removeItem("h360_community");
  window.location.assign("/");
}
export function apiUrl(path: string) {
  const url = new URL(`/api${path}`, window.location.origin);
  if (communityCode()) url.searchParams.set("community", communityCode());
  return url.pathname + url.search;
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Hostel360": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      data.error || "Something went wrong. Please try again.",
      response.status,
    );
  return data;
}
export const money = (paise: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
export const shortMoney = (paise: number) =>
  paise >= 10_000_000
    ? `₹${(paise / 10_000_000).toFixed(1)}L`
    : paise >= 100_000
      ? `₹${(paise / 100_000).toFixed(0)}k`
      : money(paise);
export const monthName = (period: string, short = false) =>
  new Date(`${period}-01T12:00:00`).toLocaleDateString("en-IN", {
    month: short ? "short" : "long",
    ...(short ? {} : { year: "numeric" }),
  });
export const dateName = (date: string) =>
  new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
export const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
export const sum = <T>(rows: T[], get: (row: T) => number) =>
  rows.reduce((total, row) => total + get(row), 0);
export function downloadCsv(
  name: string,
  headers: string[],
  rows: (string | number)[][],
) {
  const escape = (value: string | number) =>
    `"${String(value)
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  const blob = new Blob(
    [
      "\uFEFF" +
        [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n"),
    ],
    { type: "text/csv;charset=utf-8" },
  );
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
