"use strict";

const { randomBytes } = require("node:crypto");
const { getEnv } = require("./_lib/jobber");

module.exports = async function handler(req, res) {
  try {
    const state = randomBytes(16).toString("hex");
    const redirectUri = getEnv("JOBBER_REDIRECT_URI");
    const clientId = getEnv("JOBBER_CLIENT_ID");

    const authorizeUrl = new URL("https://api.getjobber.com/api/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);

    res.statusCode = 302;
    res.setHeader(
      "Set-Cookie",
      `jobber_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    );
    res.setHeader("Location", authorizeUrl.toString());
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(error.message || "Unable to start Jobber connect flow.");
  }
};
