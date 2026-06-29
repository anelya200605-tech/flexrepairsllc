"use strict";

const {
  getEnv,
  jobberGraphQL,
  refreshAccessToken,
  sendJson
} = require("./_lib/jobber");
const { runRedisCommand, runRedisPipeline } = require("./_lib/upstash");

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

async function getTypeDefinition(accessToken, typeName) {
  const data = await jobberGraphQL(
    accessToken,
    `
      query CodexTypeDefinition($name: String!) {
        __type(name: $name) {
          kind
          name
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
          possibleTypes {
            name
          }
        }
      }
    `,
    { name: typeName }
  );

  return data && data.data ? data.data.__type : null;
}

function summarizeField(field) {
  return {
    name: field.name,
    type: typeToString(field.type),
    namedType: unwrapNamedType(field.type).name || "",
    args: (field.args || []).map((arg) => ({
      name: arg.name,
      type: typeToString(arg.type),
      namedType: unwrapNamedType(arg.type).name || ""
    }))
  };
}

function byInterestingName(name) {
  return /(scheduled|visit|assessment|job|request)/i.test(String(name || ""));
}

async function readRecentRedisItems(listKey, itemPrefix, limit = 10) {
  const ids = await runRedisCommand(["LRANGE", listKey, 0, Math.max(0, limit - 1)]).catch(() => []);
  if (!Array.isArray(ids) || !ids.length) {
    return [];
  }

  const pipeline = ids.map((id) => ["GET", `${itemPrefix}${id}`]);
  const results = await runRedisPipeline(pipeline).catch(() => []);

  return ids.map((id, index) => {
    const entry = Array.isArray(results) ? results[index] : null;
    const raw = entry && typeof entry === "object" && "result" in entry ? entry.result : null;

    if (!raw) {
      return { id, missing: true };
    }

    try {
      return { id, data: JSON.parse(raw) };
    } catch {
      return { id, raw };
    }
  });
}

async function summarizeType(accessToken, typeName) {
  const type = await getTypeDefinition(accessToken, typeName);
  if (!type) return null;

  return {
    name: type.name,
    kind: type.kind,
    possibleTypes: (type.possibleTypes || []).map((item) => item.name),
    inputFields: (type.inputFields || []).map((field) => ({
      name: field.name,
      type: typeToString(field.type),
      namedType: unwrapNamedType(field.type).name || ""
    })),
    fields: (type.fields || []).map((field) => ({
      name: field.name,
      type: typeToString(field.type),
      namedType: unwrapNamedType(field.type).name || ""
    }))
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { ok: false, message: "Method not allowed." });
  }

  try {
    const [recentWebhookAttempts, recentWebhookEvents, recentEmailLogs] = await Promise.all([
      readRecentRedisItems("flex-repairs:webhook-attempts", "flex-repairs:webhook-attempt:"),
      readRecentRedisItems("flex-repairs:webhook-events", "flex-repairs:webhook-event:"),
      readRecentRedisItems("flex-repairs:email-logs", "flex-repairs:email-log:")
    ]);

    let queryFields = [];
    let relatedTypes = [];
    let jobberError = null;

    try {
      const refreshToken = getEnv("JOBBER_REFRESH_TOKEN");
      const tokenData = await refreshAccessToken(refreshToken);
      const accessToken = String(tokenData.access_token || "").trim();

      if (!accessToken) {
        throw new Error("Jobber access token is missing after refresh.");
      }

      const queryType = await getTypeDefinition(accessToken, "Query");
      const allFields = (queryType && queryType.fields) || [];
      const interestingFields = allFields.filter((field) => byInterestingName(field.name));

      const relatedTypeNames = new Set();

      interestingFields.forEach((field) => {
        const namedType = unwrapNamedType(field.type);
        if (namedType && namedType.name) {
          relatedTypeNames.add(namedType.name);
        }

        (field.args || []).forEach((arg) => {
          const argType = unwrapNamedType(arg.type);
          if (argType && argType.name && byInterestingName(argType.name)) {
            relatedTypeNames.add(argType.name);
          }
        });
      });

      const collectedTypes = [];
      const extraTypeNames = [
        "DateRange",
        "Iso8601DateTimeRangeInput",
        "ScheduledItemType",
        "ScheduledItemStatus",
        "SchedulingAspect",
        "ScheduledItemsSortInput",
        "VisitFilterAttributes",
        "ScheduledItemsFilterAttributes",
        "ScheduledItemInterface",
        "Visit",
        "Assessment",
        "VisitConnection",
        "ScheduledItemInterfaceConnection",
        "Job",
        "JobConnection"
      ];

      for (const typeName of [...relatedTypeNames]) {
        const summary = await summarizeType(accessToken, typeName);
        if (!summary) continue;

        collectedTypes.push(summary);

        for (const field of summary.fields || []) {
          if (byInterestingName(field.name) || byInterestingName(field.namedType)) {
            const nested = await summarizeType(accessToken, field.namedType);
            if (nested && !collectedTypes.some((item) => item.name === nested.name)) {
              collectedTypes.push(nested);
            }
          }
        }
      }

      for (const typeName of extraTypeNames) {
        if (collectedTypes.some((item) => item.name === typeName)) continue;
        const summary = await summarizeType(accessToken, typeName);
        if (summary) {
          collectedTypes.push(summary);
        }
      }

      queryFields = interestingFields.map(summarizeField);
      relatedTypes = collectedTypes;
    } catch (error) {
      jobberError = error.message || "Unable to inspect Jobber schedule schema.";
    }

    return sendJson(res, 200, {
      ok: true,
      queryFields,
      relatedTypes,
      jobberError,
      recentWebhookAttempts,
      recentWebhookEvents,
      recentEmailLogs
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      message: error.message || "Unable to inspect Jobber schedule schema."
    });
  }
};
