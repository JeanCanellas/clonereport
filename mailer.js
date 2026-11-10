'use strict';
// Sends alert emails through Resend's HTTP API (https://resend.com), so no SMTP library is needed.
// Email alerts are off unless RESEND_API_KEY and ALERT_FROM are set. With MAIL_TEST=1 messages
// are kept in `sent` instead of being delivered (used by the tests).

const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.ALERT_FROM || '';           // e.g. "Clone Report <alerts@clonereport.com>"
const TEST = process.env.MAIL_TEST === '1';

const sent = [];
const enabled = TEST || !!(KEY && FROM);

async function send({ to, subject, text }) {
  if (TEST) { sent.push({ to, subject, text }); return true; }
  if (!enabled) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
  return true;
}

module.exports = { enabled, send, sent };
