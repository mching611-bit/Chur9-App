// Opt-in email channel (M2 brief: "via the SendGrid/Postmark account from
// M0"). This account is Postmark.

const POSTMARK_URL = "https://api.postmarkapp.com/email";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  serverToken: string;
  from: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const res = await fetch(POSTMARK_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": input.serverToken,
    },
    body: JSON.stringify({
      From: input.from,
      To: input.to,
      Subject: input.subject,
      TextBody: input.text,
      MessageStream: "outbound",
    }),
  });
  if (!res.ok) {
    console.error("Postmark send failed", res.status, await res.text());
  }
}
