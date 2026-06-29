"use strict";

const GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const API_VERSION = process.env.JOBBER_API_VERSION || "2025-04-16";

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return String(value).trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f2ec;
        --ink: #111111;
        --muted: #655f59;
        --brand: #ef6b1f;
        --panel: #ffffff;
        --line: #eadfd4;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #fff8f3 0%, var(--bg) 100%);
        color: var(--ink);
      }
      .wrap {
        max-width: 760px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(17, 17, 17, 0.08);
      }
      h1 {
        margin: 0 0 14px;
        font-size: 2rem;
        line-height: 1.1;
      }
      p {
        margin: 0 0 14px;
        line-height: 1.6;
      }
      .token {
        margin: 18px 0;
        padding: 16px;
        border-radius: 18px;
        background: #fff7f0;
        border: 1px solid #f0d4bf;
        overflow-wrap: anywhere;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.94rem;
      }
      .label {
        display: inline-block;
        margin-bottom: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--brand);
        color: #fff;
        font-weight: 700;
        font-size: 0.8rem;
      }
      .muted {
        color: var(--muted);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        ${body}
      </section>
    </main>
  </body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return acc;

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

async function exchangeAuthorizationCode(code) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: getEnv("JOBBER_CLIENT_ID"),
      client_secret: getEnv("JOBBER_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: getEnv("JOBBER_REDIRECT_URI")
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Unable to exchange authorization code.");
  }

  return data;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: getEnv("JOBBER_CLIENT_ID"),
      client_secret: getEnv("JOBBER_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Unable to refresh Jobber access token.");
  }

  return data;
}

async function jobberGraphQL(accessToken, query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": API_VERSION
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Jobber GraphQL request failed: ${JSON.stringify(data)}`);
  }

  if (Array.isArray(data.errors) && data.errors.length) {
    throw new Error(`Jobber GraphQL errors: ${data.errors.map((item) => item.message).join("; ")}`);
  }

  return data;
}

module.exports = {
  API_VERSION,
  escapeHtml,
  exchangeAuthorizationCode,
  getEnv,
  jobberGraphQL,
  parseCookies,
  refreshAccessToken,
  renderPage,
  sendHtml,
  sendJson
};
