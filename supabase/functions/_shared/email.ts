// Opt-in email channel (M2 brief: "via the SendGrid/Postmark account from
// M0"). M0 isn't in this repo, so this only implements SendGrid — swap the
// fetch call if the account turns out to be Postmark instead.

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  apiKey: string;
  from: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const res = await fetch(SENDGRID_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: input.from },
      subject: input.subject,
      content: [{ type: "text/plain", value: input.text }],
    }),
  });
  if (!res.ok) {
    console.error("SendGrid send failed", res.status, await res.text());
  }
}
