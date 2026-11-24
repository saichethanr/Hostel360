import nodemailer from "nodemailer";

// Sends app email through the hostel's SMTP provider (Brevo). Without SMTP
// settings, such as on a local preview, the message is logged instead.
export async function sendMail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    console.log("Email not configured; would send:", {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return false;
  }
  const port = Number(SMTP_PORT || 587);
  await nodemailer
    .createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
    .sendMail({ from: MAIL_FROM, ...message });
  return true;
}
