/**
 * Mail sender for the run report and the watchdog alert.
 *
 * Send the report via the Microsoft 365 Graph API using the client-credentials
 * (application) flow. Requires an app registration with the Mail.Send application
 * permission + admin consent. Credentials come from environment variables
 * (see .env): MS365_TENANT_ID, MS365_CLIENT_ID, MS365_CLIENT_SECRET, MS365_FROM_ADDRESS.
 *
 * Uses the platform `fetch`; no mail library is involved.
 *
 * @module email
 */

/**
 * Acquire a Microsoft Graph access token via the client-credentials flow.
 * Reads MS365_TENANT_ID / MS365_CLIENT_ID / MS365_CLIENT_SECRET from the environment.
 * Throws with a clear message if creds are missing or rejected.
 *
 * @returns {Promise<string>} A bearer token for `https://graph.microsoft.com/.default`.
 * @throws {Error} When any of the three variables is missing (all missing names are
 *   listed), or when the token endpoint rejects the request.
 */
export async function getGraphToken() {
  const tenantId = process.env.MS365_TENANT_ID;
  const clientId = process.env.MS365_CLIENT_ID;
  const clientSecret = process.env.MS365_CLIENT_SECRET;

  const missing = [
    ['MS365_TENANT_ID', tenantId],
    ['MS365_CLIENT_ID', clientId],
    ['MS365_CLIENT_SECRET', clientSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing Graph env vars: ${missing.join(', ')} (see .env).`);
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  return data.access_token;
}

/**
 * Send an HTML report email via Microsoft Graph.
 * Reads credentials from process.env. Returns the "from" address on success.
 *
 * The message is saved to the sender's Sent Items, so there is a record of every report
 * that left the machine.
 *
 * @param {object} message - What to send.
 * @param {string|string[]} message.to - One recipient address or several.
 * @param {string} message.subject - Subject line.
 * @param {string} message.html - Complete HTML document used as the body.
 * @returns {Promise<string>} The MS365_FROM_ADDRESS the mail was sent from.
 * @throws {Error} When MS365_FROM_ADDRESS is missing, when a token cannot be acquired
 *   (see {@link getGraphToken}), or when Graph refuses the sendMail call.
 */
export async function sendReport({ to, subject, html }) {
  const from = process.env.MS365_FROM_ADDRESS;
  if (!from) {
    throw new Error('Missing email env var: MS365_FROM_ADDRESS (see .env).');
  }

  const token = await getGraphToken();

  const recipients = (Array.isArray(to) ? to : [to]).map((address) => ({
    emailAddress: { address },
  }));

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: recipients,
        },
        saveToSentItems: true,
      }),
    }
  );

  if (!res.ok) {
    let detail;
    try {
      const err = await res.json();
      detail = err?.error?.message || JSON.stringify(err);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Graph sendMail failed (${res.status}): ${detail}`);
  }

  return from;
}
