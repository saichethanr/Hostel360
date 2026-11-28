import type { Receipt } from "./lib";
import {
  admissionHeads,
  establishmentAccount,
  instituteKannada,
  messAccount,
  periodRange,
  rupeesInWords,
} from "../server/challan";

// A challan line. Sub-heads (level 1) sit indented under their fee.
type Line = { label: string; amount?: number; note?: string; level?: 1 };
const split = (paise: number) => {
  const [rupees, ps = "-"] = (paise / 100)
    .toLocaleString("en-IN", { maximumFractionDigits: 2 })
    .split(".");
  return [rupees, ps];
};

// The hostel's printed challan ("Duplicate for Hostel"), filled in from a
// receipt. Lines without an amount stay blank, as on the paper form.
function Challan({
  r,
  account,
  tone,
  lines,
}: {
  r: Receipt;
  account: typeof messAccount;
  tone: "mess" | "establishment";
  lines: Line[];
}) {
  const [y, m, d] = r.date.split("-");
  const [rupees, paise] = split(r.amount);
  const remitter =
    r.mode === "Sponsor" ? r.reference.replace(/^Sponsor: /, "") : r.name;
  return (
    <div className={`challan challan-${tone}`}>
      <div className="challan-no">
        Challan No. <strong>{r.receipt}</strong>
        <small>Duplicate for Hostel</small>
      </div>
      <header>
        <span className="challan-kannada" lang="kn">
          {instituteKannada}
        </span>
        <strong>{account.institute}</strong>
        <span>{account.campus}</span>
        <span>{account.city}</span>
        <strong>AMOUNT REMITTED TO {account.bank}</strong>
        <span>{account.branch}</span>
        <strong>{account.title}</strong>
        <strong className="challan-account">A/C No. {account.account}</strong>
      </header>
      <p className="challan-date">
        Date: <u>{`${d}/${m}/${y}`}</u>
      </p>
      <p>
        Name: <u>{r.name}</u> <small>{r.code}</small>
      </p>
      <p>
        Class:{" "}
        <u>
          {[r.year && `Year ${r.year}`, r.department]
            .filter(Boolean)
            .join(" · ") || "—"}
        </u>
      </p>
      <p>DCB Page No. ______ Sl. No. ______</p>
      <p>
        UPI No.: <u>{(r.mode !== "Sponsor" && r.reference) || "—"}</u>
      </p>
      <table>
        <thead>
          <tr>
            <th>Details of the Amount credited</th>
            <th>Rs.</th>
            <th>Ps.</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const [rs, ps] = l.amount ? split(l.amount) : ["", ""];
            return (
              <tr key={i} className={l.level ? "challan-sub" : undefined}>
                <td>
                  {l.label}
                  {l.note && <em>{l.note}</em>}
                </td>
                <td className="right">{rs}</td>
                <td className="right">{ps}</td>
              </tr>
            );
          })}
          <tr className="challan-total">
            <td>Total</td>
            <td className="right">{rupees}</td>
            <td className="right">{paise}</td>
          </tr>
        </tbody>
      </table>
      <p>
        Amount in words Rupees: <u>{rupeesInWords(r.amount)}</u>
      </p>
      {r.reversed_at && (
        <p className="challan-void">REVERSED · {r.reversal_reason}</p>
      )}
      <div className="challan-sign">
        <span>{remitter}</span>
        <small>Signature of the Remitter</small>
      </div>
      <p className="challan-mode">
        Paid by {r.mode} · recorded by {r.received_name}
      </p>
    </div>
  );
}

// Mess receipts: Token Charges and Others stay blank for students; Mess
// Charges shows the months this payment covered.
export function MessChallan({ r }: { r: Receipt }) {
  return (
    <Challan
      r={r}
      account={messAccount}
      tone="mess"
      lines={[
        { label: "1. Token Charges" },
        { label: "2. Others" },
        {
          label: "3. Mess Charges",
          amount: r.amount,
          note: periodRange(r.allocations.map((a) => a.period)),
        },
      ]}
    />
  );
}

// Admission receipts: one challan on the Establishment account. Each fee
// (Management, Fund, Establishment) shows its total, with every printed head
// indented under it; heads this payment did not cover stay blank. Credit kept
// for later dues goes in Others.
export function AdmissionChallan({ r }: { r: Receipt }) {
  const label = (description: string) =>
    description.replace(/^Admission · /, "");
  const lines: Line[] = [];
  admissionHeads.forEach(({ category, heads }, i) => {
    const paid = r.allocations.filter((a) => a.category === category);
    const amount = (name: string) =>
      paid
        .filter((a) => label(a.description) === name)
        .reduce((sum, a) => sum + a.amount, 0);
    // Dues raised before the heads existed keep their own description.
    const names = [
      ...heads.map((h) => h.label),
      ...new Set(
        paid
          .map((a) => label(a.description))
          .filter((name) => !heads.some((h) => h.label === name)),
      ),
    ];
    lines.push(
      {
        label: `${i + 1}. ${category}`,
        amount: paid.reduce((sum, a) => sum + a.amount, 0),
        note: [...new Set(paid.map((a) => a.period))].join(", "),
      },
      ...names.map((name) => ({
        label: name,
        amount: amount(name),
        level: 1 as const,
      })),
    );
  });
  lines.push({
    label: `${admissionHeads.length + 1}. Others`,
    amount: r.advance,
    note: r.advance ? "Credit kept for later dues" : undefined,
  });
  return (
    <Challan
      r={r}
      account={establishmentAccount}
      tone="establishment"
      lines={lines}
    />
  );
}
