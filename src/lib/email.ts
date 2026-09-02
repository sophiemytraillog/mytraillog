const RESEND_API_URL = "https://api.resend.com/emails";
const NOTIFY_TO = "mytrailloguk@gmail.com";
const FROM = "My Trail Log <onboarding@resend.dev>";

/**
 * Shared low-level sender — fire-and-forget, missing API key or a failed
 * send is logged, never thrown, so an email hiccup never turns into a 500
 * for whatever triggered it (a trail request submission, a trial-lifecycle
 * cron pass, etc).
 *
 * Note: FROM is Resend's shared sandbox domain (onboarding@resend.dev), not
 * a verified custom domain. Resend restricts sandbox-domain sends to the
 * account owner's own verified address in some account states — worth
 * confirming in the Resend dashboard that sends to arbitrary user addresses
 * (see sendUserEmail below) actually land, not just sends to NOTIFY_TO.
 */
async function sendEmail(to: string, subject: string, bodyLines: string[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping email:", subject);
    return;
  }

  try {
    const html = bodyLines
      .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
      .join("\n");

    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      console.error(`[email] Resend send failed: HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("[email] Failed to send email:", err);
  }
}

/** Notification email to the app owner (trail requests, health checks). */
export function sendNotificationEmail(subject: string, bodyLines: string[]): Promise<void> {
  return sendEmail(NOTIFY_TO, subject, bodyLines);
}

/** Transactional email to an end user (trial reminders, expiry notices). */
export function sendUserEmail(to: string, subject: string, bodyLines: string[]): Promise<void> {
  return sendEmail(to, subject, bodyLines);
}
