import { env } from '../config/env.js';

// Outbound SMS (Twilio) and email (SendGrid) behind one interface.
// send() returns a delivery result; it never pretends a message was sent when
// no provider is configured.

const withTimeout = async (url, options, ms = 12000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

const sms = {
  configured: () => Boolean(env.notifications.twilioAccountSid && env.notifications.twilioAuthToken && env.notifications.twilioFromNumber),
  async send({ to, body }) {
    if (!this.configured()) return { status: 'provider_not_configured', provider: 'twilio' };
    const { twilioAccountSid: sid, twilioAuthToken: token, twilioFromNumber: from } = env.notifications;
    const res = await withTimeout(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', provider: 'twilio', error: data?.message || `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    return { status: 'sent', provider: 'twilio', providerRef: data.sid };
  }
};

const email = {
  configured: () => Boolean(env.notifications.sendgridApiKey && env.notifications.emailFrom),
  async send({ to, subject, body }) {
    if (!this.configured()) return { status: 'provider_not_configured', provider: 'sendgrid' };
    const res = await withTimeout('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.notifications.sendgridApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.notifications.emailFrom },
        subject,
        content: [{ type: 'text/plain', value: body }]
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'failed', provider: 'sendgrid', error: text.slice(0, 300) || `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    }
    return { status: 'sent', provider: 'sendgrid', providerRef: res.headers.get('x-message-id') || undefined };
  }
};

export const notificationAdapters = { sms, email };

export const notificationStatus = () => ({
  sms: { provider: 'Twilio', configured: sms.configured() },
  email: { provider: 'SendGrid', configured: email.configured() },
  portal: { provider: 'In-app', configured: true }
});
