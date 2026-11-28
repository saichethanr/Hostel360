import type { Receipt } from "./lib";
import {
  establishmentAccount,
  instituteKannada,
  messAccount,
  periodRange,
  rupeesInWords,
} from "../server/challan";

type Line = { label: string; amount?: number; note?: string };
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
              <tr key={l.label}>
                <td>
                  {i + 1}. {l.label}
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
        { label: "Token Charges" },
        { label: "Others" },
        {
          label: "Mess Charges",
          amount: r.amount,
          note: periodRange(r.allocations.map((a) => a.period)),
        },
      ]}
    />
  );
}

// Admission receipts (Management, Fund or Establishment) share one challan on
// the Establishment account, with a line for each admission fee. The line for
// this payment's fee is filled in; credit kept for later dues goes in Others.
export function AdmissionChallan({ r }: { r: Receipt }) {
  const sum = (match: (a: Receipt["allocations"][number]) => boolean) =>
    r.allocations.filter(match).reduce((total, a) => total + a.amount, 0);
  const years = (match: (a: Receipt["allocations"][number]) => boolean) =>
    [...new Set(r.allocations.filter(match).map((a) => a.period))].join(", ");
  const caution = (a: Receipt["allocations"][number]) =>
    /caution/i.test(a.description);
  const line = (
    label: string,
    match: (a: Receipt["allocations"][number]) => boolean,
  ): Line => ({ label, amount: sum(match), note: years(match) });
  const is = (category: string) => () => r.category === category;
  return (
    <Challan
      r={r}
      account={establishmentAccount}
      tone="establishment"
      lines={[
        line("Establishment Charges", is("Establishment")),
        line("Hostel Fund", (a) => r.category === "Fund" && !caution(a)),
        line("Caution Deposit", (a) => r.category === "Fund" && caution(a)),
        line("Management Fee", is("Management")),
        {
          label: "Others",
          amount: r.advance,
          note: r.advance ? "Credit kept for later dues" : undefined,
        },
      ]}
    />
  );
}
