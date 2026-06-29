"use strict";

function getFirstDefined(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}

function getRedisConfig() {
  const url = getFirstDefined([
    "STORAGE_REDIS_REST_URL",
    "STORAGE_URL",
    "STORAGE_REST_URL",
    "UPSTASH_REDIS_REST_URL",
    "KV_REST_API_URL"
  ]);
  const token = getFirstDefined([
    "STORAGE_REDIS_REST_TOKEN",
    "STORAGE_TOKEN",
    "STORAGE_REST_TOKEN",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_TOKEN"
  ]);

  return { url, token };
}

function getSlotsKey(dateKey) {
  return `flex-repairs:slots:${dateKey}`;
}

async function runRedisCommand(command) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis storage is not connected in Vercel yet.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.error || "Redis request failed.");
  }

  return data.result;
}

async function runRedisPipeline(commands) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    throw new Error("Redis storage is not connected in Vercel yet.");
  }

  const response = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error("Redis pipeline request failed.");
  }

  return Array.isArray(data) ? data : [];
}

function createRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = {
  createRequestId,
  getSlotsKey,
  runRedisCommand,
  runRedisPipeline,
  sendJson
};
