"use strict";

const {
  createRequestId,
  getSlotsKey,
  runRedisCommand,
  runRedisPipeline,
  sendJson
} = require("./_lib/upstash");
const { sendResendEmail } = require("./_lib/resend");

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function getDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getNotificationRecipient() {
  const candidates = [
    process.env.REQUEST_NOTIFICATION_TO,
    process.env.LEAD_NOTIFICATION_TO,
    process.env.OWNER_NOTIFICATION_TO,
    process.env.NOTIFY_TO_EMAIL,
    process.env.MAIL_FROM
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }

  return "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildOwnerEmail(payload) {
  const customerName = [payload.firstName, payload.lastName].filter(Boolean).join(" ") || "Not provided";
  const addressLine =
    [payload.address, payload.city, payload.zipCode].filter(Boolean).join(", ") || "Not provided";
  const notes = payload.notes || "None";
  const lines = [
    `Request ID: ${payload.requestId}`,
    `Created at: ${payload.createdAt}`,
    `Appliance: ${payload.appliance || "Not provided"}`,
    `Issue: ${payload.issue || "Not provided"}`,
    `Brand: ${payload.brand || "Not provided"}`,
    `Preferred date: ${payload.preferredDate || payload.preferredDateKey || "Not provided"}`,
    `Preferred time: ${payload.preferredTime || "Not provided"}`,
    `Customer: ${customerName}`,
    `Phone: ${payload.phone || "Not provided"}`,
    `Email: ${payload.email || "Not provided"}`,
    `Address: ${addressLine}`,
    `Notes: ${notes}`
  ];

  return {
    subject: `New Flex Repairs request: ${payload.appliance || "Appliance service"}`,
    text: ["New Flex Repairs request", "", ...lines].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;color:#111;line-height:1.6">
        <h2 style="margin:0 0 16px">New Flex Repairs request</h2>
        ${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
      </div>
    `
  };
}

async function reserveRequestedSlot(preferredDateKey, preferredTime, requestId) {
  try {
    const result = await runRedisCommand([
      "HSETNX",
      getSlotsKey(preferredDateKey),
      preferredTime,
      requestId
    ]);

    return {
      reserved: Number(result) === 1,
      warning: ""
    };
  } catch (error) {
    return {
      reserved: true,
      warning: error && error.message ? error.message : "Temporary slot reservation storage is unavailable."
    };
  }
}

async function persistWebsiteRequest(payload) {
  try {
    await runRedisPipeline([
      ["SET", `flex-repairs:request:${payload.requestId}`, JSON.stringify(payload)],
      ["LPUSH", "flex-repairs:requests", payload.requestId]
    ]);

    return "";
  } catch (error) {
    return error && error.message ? error.message : "Website request storage is unavailable.";
  }
}

async function notifyOwner(payload) {
  const recipient = getNotificationRecipient();
  if (!recipient) {
    return {
      delivered: false,
      recipient: "",
      warning: "No request notification recipient is configured."
    };
  }

  try {
    const email = buildOwnerEmail(payload);
    await sendResendEmail({
      to: recipient,
      subject: email.subject,
      text: email.text,
      html: email.html
    });

    return {
      delivered: true,
      recipient,
      warning: ""
    };
  } catch (error) {
    return {
      delivered: false,
      recipient,
      warning: error && error.message ? error.message : "Unable to send the request notification email."
    };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, message: "Method not allowed." });
  }

  try {
    const body = getBody(req);
    const preferredDateKey = normalizeText(body.preferredDateKey);
    const preferredTime = normalizeText(body.preferredTime);
    const firstName = normalizeText(body.firstName);
    const phone = normalizeText(body.phone);
    const address = normalizeText(body.address);

    if (!preferredDateKey || !preferredTime) {
      return sendJson(res, 400, {
        ok: false,
        message: "Choose a date and an available time window."
      });
    }

    if (!firstName || getDigits(phone).length < 10 || !address) {
      return sendJson(res, 400, {
        ok: false,
        message: "Missing required customer details."
      });
    }

    const payload = {
      requestId: createRequestId(),
      createdAt: new Date().toISOString(),
      appliance: normalizeText(body.appliance),
      issue: normalizeText(body.issue),
      brand: normalizeText(body.brand),
      zipCode: normalizeText(body.zipCode),
      city: normalizeText(body.city),
      address,
      firstName,
      lastName: normalizeText(body.lastName),
      phone,
      email: normalizeEmail(body.email),
      preferredDate: normalizeText(body.preferredDate),
      preferredDateKey,
      preferredTime,
      notes: normalizeText(body.notes)
    };

    const slotReservation = await reserveRequestedSlot(preferredDateKey, preferredTime, payload.requestId);
    if (!slotReservation.reserved) {
      return sendJson(res, 409, {
        ok: false,
        message: "That time window was just booked. Please choose another one."
      });
    }

    const storageWarning = await persistWebsiteRequest(payload);
    const notification = await notifyOwner(payload);
    const warnings = [slotReservation.warning, storageWarning, notification.warning].filter(Boolean);

    return sendJson(res, 200, {
      ok: true,
      requestId: payload.requestId,
      message: notification.delivered
        ? "Request received successfully. Flex Repairs will confirm the appointment shortly."
        : "Request received successfully. Flex Repairs will review it and confirm the appointment shortly.",
      meta: {
        notificationDelivered: notification.delivered,
        notificationRecipient: notification.recipient,
        warnings
      }
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      message: error.message || "Unable to save the request right now."
    });
  }
};
