"use strict";

const {
  getEnv,
  jobberGraphQL,
  refreshAccessToken,
  sendJson
} = require("./_lib/jobber");
const {
  createRequestId,
  getSlotsKey,
  runRedisCommand,
  runRedisPipeline
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
    `Website request ID: ${payload.requestId}`,
    `Jobber request ID: ${payload.jobberRequestId || "Pending"}`,
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

function buildRequestTitle(payload) {
  const appliance = payload.appliance || "Appliance service";
  const issue = payload.issue || "Service request";
  return `${appliance} - ${issue}`.slice(0, 80);
}

function buildRequestNote(payload) {
  const customerName = [payload.firstName, payload.lastName].filter(Boolean).join(" ") || "Not provided";
  return [
    `Website request ID: ${payload.requestId}`,
    `Appliance: ${payload.appliance || "Not provided"}`,
    `Issue: ${payload.issue || "Not provided"}`,
    `Brand: ${payload.brand || "Not provided"}`,
    `Preferred date: ${payload.preferredDate || payload.preferredDateKey || "Not provided"}`,
    `Preferred time: ${payload.preferredTime || "Not provided"}`,
    `Customer: ${customerName}`,
    `Phone: ${payload.phone || "Not provided"}`,
    `Email: ${payload.email || "Not provided"}`,
    `Address: ${payload.address || "Not provided"}`,
    `City: ${payload.city || "Not provided"}`,
    `ZIP: ${payload.zipCode || "Not provided"}`,
    `Notes: ${payload.notes || "None"}`
  ].join("\n");
}

async function getAccessToken() {
  const refreshToken = getEnv("JOBBER_REFRESH_TOKEN");
  const tokenData = await refreshAccessToken(refreshToken);
  const accessToken = String(tokenData.access_token || "").trim();

  if (!accessToken) {
    throw new Error("Jobber access token is missing after refresh.");
  }

  return accessToken;
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

async function findExistingClient(accessToken, payload) {
  if (payload.email) {
    const response = await jobberGraphQL(
      accessToken,
      `
        query FlexRepairsFindClientByEmail($query: String!) {
          clients(query: $query, first: 10) {
            nodes {
              id
              firstName
              lastName
              emails {
                address
              }
              phones {
                number
              }
            }
          }
        }
      `,
      { query: payload.email }
    );

    const nodes = response && response.data && response.data.clients ? response.data.clients.nodes || [] : [];
    const matched = nodes.find((client) =>
      Array.isArray(client && client.emails)
        ? client.emails.some((item) => normalizeEmail(item && item.address) === payload.email)
        : false
    );

    if (matched && matched.id) {
      return matched.id;
    }
  }

  const phoneDigits = getDigits(payload.phone);
  if (phoneDigits) {
    const response = await jobberGraphQL(
      accessToken,
      `
        query FlexRepairsFindClientByPhone($query: String!) {
          clients(query: $query, first: 10) {
            nodes {
              id
              firstName
              lastName
              phones {
                number
              }
            }
          }
        }
      `,
      { query: phoneDigits }
    );

    const nodes = response && response.data && response.data.clients ? response.data.clients.nodes || [] : [];
    const matched = nodes.find((client) =>
      Array.isArray(client && client.phones)
        ? client.phones.some((item) => getDigits(item && item.number) === phoneDigits)
        : false
    );

    if (matched && matched.id) {
      return matched.id;
    }
  }

  return "";
}

async function createClient(accessToken, payload) {
  const response = await jobberGraphQL(
    accessToken,
    `
      mutation FlexRepairsCreateClient($input: ClientCreateInput!) {
        clientCreate(input: $input) {
          client {
            id
          }
        }
      }
    `,
    {
      input: {
        firstName: payload.firstName,
        lastName: payload.lastName || " ",
        emails: payload.email
          ? [
              {
                address: payload.email,
                primary: true
              }
            ]
          : [],
        phones: payload.phone
          ? [
              {
                number: payload.phone,
                primary: true
              }
            ]
          : []
      }
    }
  );

  const created = response && response.data && response.data.clientCreate ? response.data.clientCreate.client : null;
  if (!created || !created.id) {
    throw new Error("Jobber client was not created.");
  }

  return created.id;
}

async function findOrCreateClient(accessToken, payload) {
  const existingId = await findExistingClient(accessToken, payload);
  if (existingId) {
    return existingId;
  }

  return createClient(accessToken, payload);
}

async function createJobberRequest(accessToken, clientId, payload) {
  const response = await jobberGraphQL(
    accessToken,
    `
      mutation FlexRepairsCreateRequest($input: RequestCreateInput!) {
        requestCreate(input: $input) {
          request {
            id
            title
          }
        }
      }
    `,
    {
      input: {
        clientId,
        title: buildRequestTitle(payload)
      }
    }
  );

  const created = response && response.data && response.data.requestCreate ? response.data.requestCreate.request : null;
  if (!created || !created.id) {
    throw new Error("Jobber request was not created.");
  }

  return created;
}

async function attachRequestNote(accessToken, jobberRequestId, payload) {
  await jobberGraphQL(
    accessToken,
    `
      mutation FlexRepairsCreateRequestNote($requestId: EncodedId!, $input: RequestCreateNoteInput!) {
        requestCreateNote(requestId: $requestId, input: $input) {
          request {
            id
          }
        }
      }
    `,
    {
      requestId: jobberRequestId,
      input: {
        message: buildRequestNote(payload)
      }
    }
  );
}

async function persistWebsiteRequest(record) {
  try {
    await runRedisPipeline([
      ["SET", `flex-repairs:request:${record.requestId}`, JSON.stringify(record)],
      ["SET", `flex-repairs:jobber-request:${record.jobberRequestId}`, record.requestId],
      ["LPUSH", "flex-repairs:requests", record.requestId]
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

    const accessToken = await getAccessToken();
    const clientId = await findOrCreateClient(accessToken, payload);
    const jobberRequest = await createJobberRequest(accessToken, clientId, payload);
    await attachRequestNote(accessToken, jobberRequest.id, payload);

    const record = {
      requestId: payload.requestId,
      jobberRequestId: jobberRequest.id,
      clientId,
      createdAt: payload.createdAt,
      payload
    };

    const storageWarning = await persistWebsiteRequest(record);
    const notification = await notifyOwner({
      ...payload,
      jobberRequestId: jobberRequest.id
    });
    const warnings = [slotReservation.warning, storageWarning, notification.warning].filter(Boolean);

    return sendJson(res, 200, {
      ok: true,
      requestId: payload.requestId,
      jobberRequestId: jobberRequest.id,
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
