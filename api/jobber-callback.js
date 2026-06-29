"use strict";

const {
  API_VERSION,
  escapeHtml,
  exchangeAuthorizationCode,
  jobberGraphQL,
  parseCookies,
  renderPage,
  sendHtml
} = require("./_lib/jobber");

module.exports = async function handler(req, res) {
  try {
    const { code = "", state = "" } = req.query || {};
    const cookies = parseCookies(req.headers.cookie || "");
    const expectedState = cookies.jobber_oauth_state || "";

    if (!code) {
      throw new Error("Missing authorization code from Jobber.");
    }

    if (!state || !expectedState || state !== expectedState) {
      throw new Error("The Jobber security check failed. Please start the connect flow again.");
    }

    const tokenData = await exchangeAuthorizationCode(String(code));
    const refreshToken = String(tokenData.refresh_token || "").trim();
    const accessToken = String(tokenData.access_token || "").trim();

    if (!refreshToken || !accessToken) {
      throw new Error("Jobber did not return the tokens we need.");
    }

    let accountSummary = "";

    try {
      const graphData = await jobberGraphQL(
        accessToken,
        `
          query CodexJobberSetupCheck {
            account {
              id
              name
            }
          }
        `
      );

      const account = graphData && graphData.data && graphData.data.account;
      if (account) {
        accountSummary = `
          <p><span class="label">Connected account</span></p>
          <p><strong>${escapeHtml(account.name || "Jobber account")}</strong><br><span class="muted">ID: ${escapeHtml(account.id || "unknown")}</span></p>
        `;
      }
    } catch (graphError) {
      accountSummary = `
        <p><span class="label">GraphQL check</span></p>
        <p class="muted">${escapeHtml(graphError.message || "Jobber GraphQL check could not be completed.")}</p>
      `;
    }

    const html = renderPage(
      "Jobber Connected",
      `
        <h1>Jobber connected successfully</h1>
        <p>Your authorization worked. The next step is to save this refresh token in Vercel.</p>
        ${accountSummary}
        <p><span class="label">Refresh token</span></p>
        <div class="token">${escapeHtml(refreshToken)}</div>
        <p>Now go to <strong>Vercel → Project Settings → Environment Variables</strong> and add:</p>
        <p><code>JOBBER_REFRESH_TOKEN</code></p>
        <p class="muted">Jobber GraphQL API version in this setup: <code>${escapeHtml(API_VERSION)}</code></p>
      `
    );

    res.setHeader(
      "Set-Cookie",
      "jobber_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );
    return sendHtml(res, 200, html);
  } catch (error) {
    const html = renderPage(
      "Jobber setup error",
      `
        <h1>Jobber setup error</h1>
        <p>${escapeHtml(error.message || "Something went wrong while connecting Jobber.")}</p>
      `
    );

    return sendHtml(res, 500, html);
  }
};
