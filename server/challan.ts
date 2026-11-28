// The hostel's printed "Duplicate for Hostel" challans: Mess, and one
// Establishment-account challan for all admission fees. Shared by the receipt
// screen and the email sent to students.
// The institute's name in Kannada, as printed on every challan.
export const instituteKannada =
  "ಜೆಎಸ್‌ಎಸ್ ವಿಶೇಷಚೇತನರ ಪಾಲಿಟೆಕ್ನಿಕ್ ವಿದ್ಯಾರ್ಥಿನಿಲಯ, ಮೈಸೂರು";
export const messAccount = {
  institute: "JSS Polytechnic for the Differently Abled Hostel",
  campus: "JSS Technical Institutions' Campus",
  city: "Mysuru - 570 006",
  bank: "UNION BANK OF INDIA",
  branch: "JSS University Campus Branch, Mysuru-570 006",
  title: "HOSTEL MESS ACCOUNT",
  account: "789101010000002",
};
// Admission fees (Management, Fund, Establishment) are receipted together on
// the Establishment account's challan.
export const establishmentAccount = {
  ...messAccount,
  title: "HOSTEL ESTABLISHMENT ACCOUNT",
  account: "789102010000464",
};
// Payments and receipts come in two kinds: Mess, and Admission, which settles
// Management, Fund and Establishment dues together on one receipt.
export const payKinds = ["Mess", "Admission"];
export const payKind = (category: string) =>
  category === "Mess" ? "Mess" : "Admission";
// The admission fee heads printed on the hostel's Management, Fund and
// Establishment challans. The Admin sets an amount for each head in Settings,
// separately for freshers and existing students; each head becomes its own
// due, described as "Admission · <label>".
export const admissionHeads = [
  {
    category: "Management",
    heads: [
      ["development", "Development Fee"],
      ["room_rent", "Room Rent"],
      ["guest", "Guest Charges"],
      ["others", "Others"],
    ],
  },
  {
    category: "Fund",
    heads: [
      ["application", "Application Fee"],
      ["depreciation", "Depreciation"],
      ["electrical_water", "Electrical & Water Charges"],
      ["reading_sports", "Reading Room & Sports"],
      ["room_rent", "Room Rent"],
      ["caution", "Caution Deposit"],
      ["others", "Others"],
    ],
  },
  {
    category: "Establishment",
    heads: [
      ["establishment", "Establishment Charges"],
      ["others", "Others"],
    ],
  },
].map(({ category, heads }) => ({
  category,
  heads: heads.map(([key, label]) => ({ key, label })),
}));
// Settings key for one head, e.g. fee_fresher_fund_caution.
export const feeKey = (
  type: "fresher" | "existing",
  category: string,
  head: string,
) => `fee_${type}_${category.toLowerCase()}_${head}`;

const ones = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const tens = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];
const twoDigits = (n: number) =>
  n < 20
    ? ones[n]
    : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`;
const threeDigits = (n: number) =>
  [n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred` : "", twoDigits(n % 100)]
    .filter(Boolean)
    .join(" ");

// Indian numbering: 8046 → "Eight Thousand Forty Six", 125000 → "One Lakh
// Twenty Five Thousand".
export function rupeesInWords(paise: number) {
  const rupees = Math.floor(paise / 100),
    rest = paise % 100;
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  const words = parts.join(" ") || "Zero";
  return `${words}${rest ? ` and ${twoDigits(rest)} Paise` : ""} Only`;
}

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const month = (period: string) =>
  /^\d{4}-\d{2}$/.test(period)
    ? `${monthNames[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`
    : period;
// "May 2026 to October 2026" for the months a mess payment covers.
export function periodRange(periods: string[]) {
  const sorted = [...new Set(periods)].sort();
  if (!sorted.length) return "";
  return sorted.length === 1
    ? month(sorted[0])
    : `${month(sorted[0])} to ${month(sorted[sorted.length - 1])}`;
}

export const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const inr = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export type Challan = {
  receipt: string;
  date: string;
  name: string;
  className: string;
  reference: string;
  periods: string[];
  amount: number;
  remitter: string;
};

// The challan as an email-safe HTML table, laid out like the paper form.
export function challanHtml(c: Challan) {
  const cell = "border:1px solid #9c5b70;padding:6px 8px;";
  const row = (label: string, rupees = "", paise = "") =>
    `<tr><td style="${cell}">${label}</td><td style="${cell}text-align:right">${rupees}</td><td style="${cell}text-align:right;width:40px">${paise}</td></tr>`;
  const [rupees, paise = "-"] = inr(c.amount).split(".");
  return `<div style="max-width:460px;margin:0 auto;background:#f9d9e3;color:#3b2430;font-family:Georgia,serif;padding:20px;border:1px solid #d9a3b4">
  <div style="text-align:right;font-size:13px">Challan No. <strong style="color:#c0395f;font-size:18px">${escape(c.receipt)}</strong><br>Duplicate for Hostel</div>
  <div style="text-align:center;margin:8px 0 12px;line-height:1.4">
    <span>${instituteKannada}</span><br>
    <strong>${messAccount.institute}</strong><br>${messAccount.campus}<br>${messAccount.city}<br>
    <strong>AMOUNT REMITTED TO ${messAccount.bank}</strong><br>${messAccount.branch}<br>
    <strong>${messAccount.title}</strong><br><strong style="font-size:18px">A/C No. ${messAccount.account}</strong>
  </div>
  <p style="text-align:right;margin:4px 0">Date: <u>${escape(c.date)}</u></p>
  <p style="margin:4px 0">Name: <u>${escape(c.name)}</u></p>
  <p style="margin:4px 0">Class: <u>${escape(c.className)}</u></p>
  <p style="margin:4px 0">DCB Page No. ____ Sl. No. ____</p>
  <p style="margin:4px 0 10px">UPI No.: <u>${escape(c.reference)}</u></p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><th style="${cell}">Details of the Amount credited</th><th style="${cell}">Rs.</th><th style="${cell}">Ps.</th></tr>
    ${row("1. Token Charges")}
    ${row("2. Others")}
    ${row(`3. Mess Charges<br><em>${escape(periodRange(c.periods))}</em>`, rupees, paise)}
    ${row("<strong>Total</strong>", `<strong>${rupees}</strong>`, paise)}
  </table>
  <p style="margin:12px 0 4px">Amount in words Rupees: <u>${escape(rupeesInWords(c.amount))}</u></p>
  <p style="margin:24px 0 0;text-align:center">${escape(c.remitter)}<br><small>Signature of the Remitter</small></p>
</div>`;
}
