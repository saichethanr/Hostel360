import type { Receipt } from "./lib";
import { messAccount, periodRange, rupeesInWords } from "../server/challan";

// Mess receipts print as the hostel's mess challan ("Duplicate for Hostel").
// Token charges and Others stay blank for students; Mess Charges shows the
// months this payment covered.
export function MessChallan({ r }: { r: Receipt }) {
  const [y, m, d] = r.date.split("-");
  const [rupees, paise = "-"] = (r.amount / 100)
    .toLocaleString("en-IN", { maximumFractionDigits: 2 })
    .split(".");
  const periods = r.allocations.map((a) => a.period);
  const remitter =
    r.mode === "Sponsor" ? r.reference.replace(/^Sponsor: /, "") : r.name;
  return (
    <div className="challan">
      <div className="challan-no">
        Challan No. <strong>{r.receipt}</strong>
        <small>Duplicate for Hostel</small>
      </div>
      <header>
        <strong>{messAccount.institute}</strong>
        <span>{messAccount.campus}</span>
        <span>{messAccount.city}</span>
        <strong>AMOUNT REMITTED TO {messAccount.bank}</strong>
        <span>{messAccount.branch}</span>
        <strong>{messAccount.title}</strong>
        <strong className="challan-account">
          A/C No. {messAccount.account}
        </strong>
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
          <tr>
            <td>1. Token Charges</td>
            <td />
            <td />
          </tr>
          <tr>
            <td>2. Others</td>
            <td />
            <td />
          </tr>
          <tr>
            <td>
              3. Mess Charges
              <em>{periodRange(periods)}</em>
            </td>
            <td className="right">{rupees}</td>
            <td className="right">{paise}</td>
          </tr>
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
