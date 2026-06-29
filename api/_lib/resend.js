"use strict";

function getResendApiKey() {
  const value = process.env.RESEND_API_KEY;
  if (!value) {
    throw new Error("Missing environment variable: RESEND_API_KEY");
  }

  return String(value).trim();
}

function getMailFrom() {
  const value = process.env.MAIL_FROM;
  if (!value) {
    throw new Error("Missing environment variable: MAIL_FROM");
  }

  return String(value).trim();
}

async function sendResendEmail(payload) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getResendApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: payload.from || getMailFrom(),
      to: Array.isArray(payload.to) ? payload.to : [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      (data && data.message) ||
      (data && data.error && data.error.message) ||
      "Resend email request failed.";
    throw new Error(message);
  }

  return data;
}

module.exports = {
  getMailFrom,
  sendResendEmail
};
