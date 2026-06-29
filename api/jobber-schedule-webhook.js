"use strict";

const crypto = require("node:crypto");

const {
  getEnv,
  jobberGraphQL,
  refreshAccessToken,
  sendJson
} = require("./_lib/jobber");
const { sendResendEmail } = require("./_lib/resend");
const { getSlotsKey, runRedisCommand, runRedisPipeline } = require("./_lib/upstash");

const JOBBER_TIMEZONE = "America/Chicago";
const COMPANY_PHONE = "814-403-7859";
let cachedClientEditConfig = null;

function getRawBody(req) {
  if (typeof req.body === "string") {
    return req.body;
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  return "";
}

function getWebhookEvent(req) {
  if (!req.body) return null;
  if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && parsed.data ? parsed.data.webHookEvent || null : null;
    } catch {
      return null;
    }
  }

  return req.body && req.body.data ? req.body.data.webHookEvent || null : null;
}

function unwrapNamedType(type) {
  let current = type;

  while (current && current.ofType) {
    current = current.ofType;
  }

  return current || type;
}

function typeToString(type) {
  if (!type) return "";
  if (type.kind === "NON_NULL") return `${typeToString(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeToString(type.ofType)}]`;
  return type.name || "";
}

function verifyWebhookSignature(rawBody, headerValue) {
  if (!rawBody || !headerValue) {
    return false;
  }

  const secret = getEnv("JOBBER_CLIENT_SECRET");
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const received = Buffer.from(String(headerValue).trim(), "utf8");
  const expected = Buffer.from(digest, "utf8");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

function formatDateAndTime(startAt, endAt) {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : null;

  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: JOBBER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(start);

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: JOBBER_TIMEZONE,
    hour: "numeric",
    minute: "2-digit"
  });

  const startLabel = timeFormatter.format(start);
  const time = end ? `${startLabel} - ${timeFormatter.format(end)}` : startLabel;

  return { date, time };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildConfirmationEmail(context) {
  const { clientName, appointmentDate, appointmentTime, addressLine, appliance, issue } = context;

  const safeName = escapeHtml(clientName || "there");
  const safeDate = escapeHtml(appointmentDate);
  const safeTime = escapeHtml(appointmentTime);
  const safeAddress = escapeHtml(addressLine);
  const safeAppliance = escapeHtml(appliance || "Appliance service");
  const safeIssue = escapeHtml(issue || "Service request");

  return {
    subject: `Your Flex Repairs appointment is confirmed`,
    text: [
      `Hello ${clientName || "there"},`,
      "",
      "Your appointment with Flex Repairs has been confirmed.",
      "",
      `Service: ${appliance || "Appliance service"}`,
      `Issue: ${issue || "Service request"}`,
      `Date: ${appointmentDate}`,
      `Time: ${appointmentTime}`,
      `Address: ${addressLine}`,
      "",
      `If you need help, please call ${COMPANY_PHONE}.`,
      "",
      "Thank you,",
      "Flex Repairs LLC"
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;color:#111;line-height:1.6">
        <p>Hello ${safeName},</p>
        <p>Your appointment with <strong>Flex Repairs</strong> has been confirmed.</p>
        <p>
          <strong>Service:</strong> ${safeAppliance}<br>
          <strong>Issue:</strong> ${safeIssue}<br>
          <strong>Date:</strong> ${safeDate}<br>
          <strong>Time:</strong> ${safeTime}<br>
          <strong>Address:</strong> ${safeAddress}
        </p>
        <p>If you need help, please call <a href="tel:${COMPANY_PHONE}">${COMPANY_PHONE}</a>.</p>
        <p>Thank you,<br>Flex Repairs LLC</p>
      </div>
    `
  };
}

function getClientEmail(client) {
  if (!client || typeof client !== "object") return "";

  const defaultEmails = Array.isArray(client.defaultEmails) ? client.defaultEmails : [];
  for (const value of defaultEmails) {
    const candidate = String(value || "").trim();
    if (candidate) return candidate;
  }

  const emails = Array.isArray(client.emails) ? client.emails : [];
  for (const item of emails) {
    const candidate = item && typeof item === "object" ? String(item.address || "").trim() : "";
    if (candidate) return candidate;
  }

  return "";
}

function getClientName(client) {
  if (!client || typeof client !== "object") return "";

  const firstName = String(client.firstName || "").trim();
  const lastName = String(client.lastName || "").trim();
  return `${firstName} ${lastName}`.trim();
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

async function fetchAssessmentDetails(accessToken, itemId) {
  const response = await jobberGraphQL(
    accessToken,
    `
      query FlexRepairsAssessmentForEmail($id: EncodedId!) {
        assessment(id: $id) {
          id
          startAt
          endAt
          title
          property {
            name
          }
          request {
            id
            source
            title
            contactName
            email
            phone
            client {
              id
              firstName
              lastName
              defaultEmails
              emails {
                address
              }
            }
          }
        }
      }
    `,
    { id: itemId }
  );

  const assessment = response && response.data ? response.data.assessment : null;
  if (!assessment) {
    throw new Error("Jobber assessment was not found.");
  }

  return {
    itemType: "assessment",
    itemId: assessment.id,
    startAt: assessment.startAt,
    endAt: assessment.endAt,
    addressLine: assessment.property && assessment.property.name ? assessment.property.name : "",
    request: assessment.request || null
  };
}

async function fetchVisitDetails(accessToken, itemId) {
  const response = await jobberGraphQL(
    accessToken,
    `
      query FlexRepairsVisitForEmail($id: EncodedId!) {
        visit(id: $id) {
          id
          startAt
          endAt
          title
          property {
            name
          }
          job {
            id
            request {
              id
              source
              title
              contactName
              email
              phone
              client {
                id
                firstName
                lastName
                defaultEmails
                emails {
                  address
                }
              }
            }
          }
        }
      }
    `,
    { id: itemId }
  );

  const visit = response && response.data ? response.data.visit : null;
  if (!visit) {
    throw new Error("Jobber visit was not found.");
  }

  return {
    itemType: "visit",
    itemId: visit.id,
    startAt: visit.startAt,
    endAt: visit.endAt,
    addressLine: visit.property && visit.property.name ? visit.property.name : "",
    request: visit.job && visit.job.request ? visit.job.request : null
  };
}

async function fetchRequestDetails(accessToken, itemId) {
  const response = await jobberGraphQL(
    accessToken,
    `
      query FlexRepairsRequestForEmail($id: EncodedId!) {
        request(id: $id) {
          id
          source
          title
          contactName
          email
          phone
          client {
            id
            firstName
            lastName
            defaultEmails
            emails {
              address
            }
          }
          property {
            name
          }
          assessment {
            id
            startAt
            endAt
            title
            property {
              name
            }
          }
        }
      }
    `,
    { id: itemId }
  );

  const request = response && response.data ? response.data.request : null;
  if (!request) {
    throw new Error("Jobber request was not found.");
  }

  const assessment = request.assessment || null;
  if (!assessment || !assessment.startAt) {
    return {
      itemType: "request",
      itemId: request.id,
      startAt: null,
      endAt: null,
      addressLine: request.property && request.property.name ? request.property.name : "",
      request
    };
  }

  return {
    itemType: "assessment",
    itemId: assessment.id || request.id,
    startAt: assessment.startAt,
    endAt: assessment.endAt,
    addressLine:
      (assessment.property && assessment.property.name) ||
      (request.property && request.property.name) ||
      "",
    request
  };
}

async function fetchScheduledItemDetails(accessToken, topic, itemId) {
  const normalized = String(topic || "").toUpperCase();

  if (normalized.includes("ASSESSMENT")) {
    return fetchAssessmentDetails(accessToken, itemId);
  }

  if (normalized.includes("VISIT")) {
    return fetchVisitDetails(accessToken, itemId);
  }

  if (normalized.includes("REQUEST")) {
    return fetchRequestDetails(accessToken, itemId);
  }

  return null;
}

async function loadWebsiteRequestData(jobberRequestId) {
  if (!jobberRequestId) return null;

  const lookup = await runRedisCommand(["GET", `flex-repairs:jobber-request:${jobberRequestId}`]);
  if (!lookup) return null;

  const serialized = await runRedisCommand(["GET", `flex-repairs:request:${lookup}`]);
  if (!serialized) return null;

  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

async function clearTemporaryRequestedSlot(websiteRequest) {
  const payload = websiteRequest && websiteRequest.payload ? websiteRequest.payload : null;
  if (!payload) return;

  const preferredDateKey = String(payload.preferredDateKey || "").trim();
  const preferredTime = String(payload.preferredTime || "").trim();

  if (!preferredDateKey || !preferredTime) {
    return;
  }

  await runRedisCommand(["HDEL", getSlotsKey(preferredDateKey), preferredTime]);
}

async function getTypeDefinition(accessToken, typeName) {
  const data = await jobberGraphQL(
    accessToken,
    `
      query FlexRepairsTypeDefinition($name: String!) {
        __type(name: $name) {
          kind
          name
          enumValues {
            name
          }
          inputFields {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
          fields {
            name
            args {
              name
              type {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { name: typeName }
  );

  return data && data.data ? data.data.__type : null;
}

async function getClientEditConfig(accessToken) {
  if (cachedClientEditConfig) {
    return cachedClientEditConfig;
  }

  const mutationType = await getTypeDefinition(accessToken, "Mutation");
  const fields = Array.isArray(mutationType && mutationType.fields) ? mutationType.fields : [];
  const clientEditField = fields.find((field) => field && field.name === "clientEdit");

  if (!clientEditField) {
    cachedClientEditConfig = null;
    return null;
  }

  const args = Array.isArray(clientEditField.args) ? clientEditField.args : [];
  const idArg =
    args.find((arg) => /clientid/i.test(String(arg.name || ""))) ||
    args.find((arg) => /(^id$|client)/i.test(String(arg.name || "")));
  const attributesArg =
    args.find((arg) => /attributes/i.test(String(arg.name || ""))) ||
    args.find((arg) => /input/i.test(String(arg.name || "")));

  if (!idArg || !attributesArg) {
    cachedClientEditConfig = null;
    return null;
  }

  const inputTypeName = unwrapNamedType(attributesArg.type).name || "";
  const inputType = inputTypeName ? await getTypeDefinition(accessToken, inputTypeName) : null;
  const inputFields = Array.isArray(inputType && inputType.inputFields) ? inputType.inputFields : [];
  const titleField = inputFields.find((field) => field.name === "title");
  const titleNamedType = titleField ? unwrapNamedType(titleField.type).name || "" : "";
  const titleType = titleNamedType ? await getTypeDefinition(accessToken, titleNamedType) : null;
  const titleEnumValues = Array.isArray(titleType && titleType.enumValues)
    ? titleType.enumValues.map((item) => item.name).filter(Boolean)
    : [];

  cachedClientEditConfig = {
    mutationName: clientEditField.name,
    idArgName: idArg.name,
    attributesArgName: attributesArg.name,
    inputTypeName,
    supportsTitle: inputFields.some((field) => field.name === "title"),
    supportsFirstName: inputFields.some((field) => field.name === "firstName"),
    supportsLastName: inputFields.some((field) => field.name === "lastName"),
    titleNamedType,
    titleEnumValues
  };

  return cachedClientEditConfig;
}

function uniqueAttempts(attempts) {
  const seen = new Set();

  return attempts.filter((attempt) => {
    const key = JSON.stringify(attempt);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildTitleClearAttempts(config, client) {
  const baseAttributes = {};

  if (config.supportsFirstName) {
    baseAttributes.firstName = String(client.firstName || "").trim();
  }

  if (config.supportsLastName) {
    baseAttributes.lastName = String(client.lastName || "").trim();
  }

  if (!config.supportsTitle) {
    return [];
  }

  const attempts = [];
  const enumValues = Array.isArray(config.titleEnumValues) ? config.titleEnumValues : [];
  const neutralEnum = enumValues.find((value) =>
    /^(NONE|NO_TITLE|NOHONORIFIC|NO_HONORIFIC|UNSPECIFIED|UNKNOWN|NOT_APPLICABLE|NA)$/i.test(
      String(value || "")
    )
  );

  if (neutralEnum) {
    attempts.push({ ...baseAttributes, title: neutralEnum });
  }

  attempts.push({ ...baseAttributes, title: "" });
  attempts.push({ ...baseAttributes, title: null });
  attempts.push({ title: "" });
  attempts.push({ title: null });

  return uniqueAttempts(attempts);
}

async function clearClientHonorific(accessToken, request) {
  const client = request && request.client ? request.client : null;
  if (!client || !client.id) {
    return false;
  }

  const config = await getClientEditConfig(accessToken);
  if (!config || !config.supportsTitle) {
    return false;
  }

  const attempts = buildTitleClearAttempts(config, client);
  let lastError = null;

  for (const attributes of attempts) {
    try {
      await jobberGraphQL(
        accessToken,
        `
          mutation FlexRepairsClearHonorific($clientId: EncodedId!, $attributes: ${config.inputTypeName}!) {
            ${config.mutationName}(${config.idArgName}: $clientId, ${config.attributesArgName}: $attributes) {
              client {
                id
              }
            }
          }
        `,
        {
          clientId: client.id,
          attributes
        }
      );

      return true;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return false;
}

async function reserveEmailFingerprint(fingerprint) {
  const result = await runRedisCommand([
    "SET",
    `flex-repairs:email-confirmation:${fingerprint}`,
    new Date().toISOString(),
    "NX",
    "EX",
    "15552000"
  ]);

  return result === "OK";
}

async function releaseEmailFingerprint(fingerprint) {
  if (!fingerprint) return;
  await runRedisCommand(["DEL", `flex-repairs:email-confirmation:${fingerprint}`]);
}

async function recordEmailLog(meta) {
  const id = `${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;

  await runRedisPipeline([
    [
      "SET",
      `flex-repairs:email-log:${id}`,
      JSON.stringify(meta),
      "EX",
      "2592000"
    ],
    ["LPUSH", "flex-repairs:email-logs", id]
  ]);
}

async function recordWebhookAttempt(meta) {
  const id = `${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;

  await runRedisPipeline([
    [
      "SET",
      `flex-repairs:webhook-attempt:${id}`,
      JSON.stringify(meta),
      "EX",
      "2592000"
    ],
    ["LPUSH", "flex-repairs:webhook-attempts", id]
  ]);
}

async function queueWebhookEvent(event, topic) {
  const webhookFingerprint = [topic, event.itemId, event.occurredAt || event.occuredAt || ""].join(":");
  const shouldProcess = await runRedisCommand([
    "SET",
    `flex-repairs:webhook:${webhookFingerprint}`,
    "1",
    "NX",
    "EX",
    "2592000"
  ]);

  if (shouldProcess !== "OK") {
    return { accepted: false, duplicate: true, fingerprint: webhookFingerprint };
  }

  await runRedisPipeline([
    [
      "SET",
      `flex-repairs:webhook-event:${webhookFingerprint}`,
      JSON.stringify({
        topic,
        itemId: event.itemId,
        occurredAt: event.occurredAt || event.occuredAt || "",
        receivedAt: new Date().toISOString()
      }),
      "EX",
      "2592000"
    ],
    ["LPUSH", "flex-repairs:webhook-events", webhookFingerprint]
  ]);

  return { accepted: true, duplicate: false, fingerprint: webhookFingerprint };
}

async function releaseWebhookFingerprint(fingerprint) {
  if (!fingerprint) return;
  await runRedisCommand(["DEL", `flex-repairs:webhook:${fingerprint}`]);
}

async function handleScheduledWebhook(event) {
  const baseMeta = {
    topic: String(event.topic || "").toUpperCase(),
    itemId: String(event.itemId || ""),
    occurredAt: String(event.occurredAt || event.occuredAt || ""),
    processedAt: new Date().toISOString()
  };

  const accessToken = await getAccessToken();
  const scheduled = await fetchScheduledItemDetails(accessToken, event.topic, event.itemId);

  if (!scheduled || !scheduled.request || !scheduled.request.id) {
    await recordEmailLog({
      ...baseMeta,
      status: "skipped",
      reason: "No linked Jobber request on scheduled item."
    });
    return { skipped: true, reason: "No linked Jobber request on scheduled item." };
  }

  const websiteRequest = await loadWebsiteRequestData(scheduled.request.id);
  let honorificClearError = "";
  try {
    await clearClientHonorific(accessToken, scheduled.request);
  } catch (error) {
    honorificClearError = error && error.message ? error.message : "Unknown title cleanup error.";
  }

  if (!scheduled.startAt) {
    await recordEmailLog({
      ...baseMeta,
      jobberRequestId: scheduled.request.id,
      status: "skipped",
      reason: "Request does not have a scheduled assessment yet.",
      honorificClearError
    });
    return { skipped: true, reason: "Request does not have a scheduled assessment yet." };
  }

  await clearTemporaryRequestedSlot(websiteRequest).catch(() => {});
  const payload = websiteRequest && websiteRequest.payload ? websiteRequest.payload : {};
  const requestClient = scheduled.request.client || null;
  const email = String(
    payload.email ||
      scheduled.request.email ||
      getClientEmail(requestClient) ||
      ""
  ).trim();

  if (!email) {
    await recordEmailLog({
      ...baseMeta,
      jobberRequestId: scheduled.request.id,
      status: "skipped",
      reason: "No email address was found for this request."
    });
    return { skipped: true, reason: "No email address was found for this request." };
  }

  const { date, time } = formatDateAndTime(scheduled.startAt, scheduled.endAt);
  const addressLine =
    scheduled.addressLine ||
    payload.address ||
    payload.propertyAddress ||
    payload.billingAddress ||
    "Address to be confirmed";
  const clientName =
    String(payload.firstName || "").trim() ||
    String(scheduled.request.contactName || "").trim() ||
    getClientName(requestClient) ||
    "there";

  const fingerprint = [
    scheduled.itemType,
    scheduled.itemId,
    scheduled.startAt || "",
    scheduled.endAt || ""
  ].join(":");

  const shouldSend = await reserveEmailFingerprint(fingerprint);
  if (!shouldSend) {
    await recordEmailLog({
      ...baseMeta,
      fingerprint,
      jobberRequestId: scheduled.request.id,
      status: "skipped",
      reason: "Confirmation for this scheduled slot was already sent or is already being processed.",
      email
    });
    return { skipped: true, reason: "Confirmation for this scheduled slot was already sent." };
  }

  const emailContent = buildConfirmationEmail({
    clientName,
    appointmentDate: date,
    appointmentTime: time,
    addressLine,
    appliance:
      payload.appliance ||
      String(scheduled.request.title || scheduled.request.source || scheduled.itemType || 'Appliance service').trim(),
    issue: payload.issue || String(scheduled.request.title || 'Scheduled service').trim()
  });

  try {
    const sendResult = await sendResendEmail({
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text
    });

    await recordEmailLog({
      ...baseMeta,
      fingerprint,
      status: "sent",
      sentAt: new Date().toISOString(),
      jobberRequestId: scheduled.request.id,
      itemType: scheduled.itemType,
      email,
      date,
      time,
      honorificClearError,
      resendId: sendResult && sendResult.id ? sendResult.id : ""
    });
  } catch (error) {
    await releaseEmailFingerprint(fingerprint).catch(() => {});
    await recordEmailLog({
      ...baseMeta,
      fingerprint,
      status: "failed",
      failedAt: new Date().toISOString(),
      jobberRequestId: scheduled.request.id,
      itemType: scheduled.itemType,
      email,
      date,
      time,
      honorificClearError,
      error: error && error.message ? error.message : "Unknown email sending error."
    });
    throw error;
  }

  return {
    skipped: false,
    email,
    date,
    time
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, message: "Method not allowed." });
  }

  let queueResult = null;
  let parsedEvent = null;

  try {
    const rawBody = getRawBody(req);
    const signature = req.headers["x-jobber-hmac-sha256"] || req.headers["X-Jobber-Hmac-SHA256"];
    parsedEvent = getWebhookEvent(req);
    const signatureValid = verifyWebhookSignature(rawBody, signature);

    await recordWebhookAttempt({
      receivedAt: new Date().toISOString(),
      topic: parsedEvent && parsedEvent.topic ? String(parsedEvent.topic) : "",
      itemId: parsedEvent && parsedEvent.itemId ? String(parsedEvent.itemId) : "",
      occurredAt:
        parsedEvent && (parsedEvent.occurredAt || parsedEvent.occuredAt)
          ? String(parsedEvent.occurredAt || parsedEvent.occuredAt)
          : "",
      hasSignature: Boolean(signature),
      signatureValid,
      bodyPreview: rawBody ? String(rawBody).slice(0, 1000) : ""
    });

    if (!signatureValid) {
      return sendJson(res, 401, { ok: false, message: "Invalid Jobber webhook signature." });
    }

    const event = parsedEvent;
    if (!event || !event.topic || !event.itemId) {
      return sendJson(res, 400, { ok: false, message: "Invalid webhook payload." });
    }

    const topic = String(event.topic || "").toUpperCase();
    const relevant =
      ((topic.includes("ASSESSMENT") || topic.includes("VISIT")) &&
        (topic.includes("CREATE") || topic.includes("UPDATE"))) ||
      (topic.includes("REQUEST") && (topic.includes("CREATE") || topic.includes("UPDATE")));

    if (!relevant) {
      return sendJson(res, 200, { ok: true, ignored: true });
    }

    queueResult = await queueWebhookEvent(event, topic);
    if (queueResult.duplicate) {
      return sendJson(res, 200, { ok: true, duplicate: true });
    }

    const processed = await handleScheduledWebhook({
      ...event,
      topic
    });

    return sendJson(res, 200, {
      ok: true,
      accepted: true,
      skipped: Boolean(processed && processed.skipped)
    });
  } catch (error) {
    if (queueResult && queueResult.fingerprint) {
      await releaseWebhookFingerprint(queueResult.fingerprint).catch(() => {});
    }

    await recordEmailLog({
      topic: parsedEvent && parsedEvent.topic ? String(parsedEvent.topic).toUpperCase() : "",
      itemId: parsedEvent && parsedEvent.itemId ? String(parsedEvent.itemId) : "",
      occurredAt:
        parsedEvent && (parsedEvent.occurredAt || parsedEvent.occuredAt)
          ? String(parsedEvent.occurredAt || parsedEvent.occuredAt)
          : "",
      processedAt: new Date().toISOString(),
      status: "failed",
      reason: error && error.message ? error.message : "Unhandled webhook error."
    }).catch(() => {});

    return sendJson(res, 500, {
      ok: false,
      message: error.message || "Unable to process Jobber schedule webhook."
    });
  }
};
