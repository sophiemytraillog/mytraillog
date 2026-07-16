const RESEND_API_URL = "https://api.resend.com/emails";
const NOTIFY_TO = "mytrailloguk@gmail.com";
const FROM = "My Trail Log <onboarding@resend.dev>";

/**
 * Fire-and-forget notification email via Resend. Missing API key or a
 * failed send is logged, never thrown — a trail request is already saved
 * to the DB by the time this runs, so an email hiccup shouldn't turn into
 * a 500 for the person submitting the form.
 */
export async function sendNotificationEmail(subject: string, bodyLines: string[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping notification:", subject);
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
        to: [NOTIFY_TO],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      console.error(`[email] Resend send failed: HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("[email] Failed to send notification:", err);
  }
}
