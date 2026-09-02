import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service - My Trail Log",
};

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 101.06-1.061l-8.689-8.69a2.25 2.25 0 00-3.182 0l-8.69 8.69a.75.75 0 101.061 1.06l8.69-8.689z" />
      <path d="M12 5.432l8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75V21a.75.75 0 01-.75.75H5.625a1.875 1.875 0 01-1.875-1.875v-6.198c.03-.028.061-.056.091-.086L12 5.432z" />
    </svg>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold text-[#2C2520] mb-3 pb-2 border-b border-[#E5DED4]">{title}</h2>
      <div className="space-y-3 text-[#2C2520]/80 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-5 flex items-center justify-between border-b border-[#E5DED4]">
        <Link href="/" className="flex items-center gap-2 text-[#2C2520] hover:opacity-80 transition-opacity">
          <LogoIcon className="w-5 h-5 text-[#C4652A]" />
          <span className="font-semibold text-base tracking-tight">My Trail Log</span>
        </Link>
        <Link href="/" className="text-sm text-[#8A7F72] hover:text-[#2C2520] transition-colors">
          ← Back to home
        </Link>
      </nav>

      {/* Content */}
      <main className="flex-1 px-6 py-12">
        <div className="max-w-2xl mx-auto">

          {/* Page header */}
          <div className="mb-10">
            <div className="inline-flex items-center gap-2 bg-[#C4652A]/10 border border-[#C4652A]/20 text-[#C4652A] text-xs font-semibold tracking-[0.12em] uppercase px-3 py-1.5 rounded-full mb-4">
              Legal
            </div>
            <h1 className="text-3xl font-extrabold text-[#2C2520] tracking-tight mb-2">Terms of Service</h1>
            <p className="text-[#8A7F72] text-sm">Last updated: 26 May 2026</p>
          </div>

          <Section title="1. Acceptance of terms">
            <p>
              By creating an account or using My Trail Log (&ldquo;the Service&rdquo;, &ldquo;we&rdquo;,
              &ldquo;us&rdquo;, &ldquo;our&rdquo;), you agree to be bound by these Terms of Service
              (&ldquo;Terms&rdquo;). Please read them carefully before using the Service. If you do not
              agree to these Terms, you must not use the Service.
            </p>
            <p>
              We reserve the right to update these Terms at any time. We will notify you of material
              changes by updating the date at the top of this page. Continued use of the Service after
              changes are posted constitutes your acceptance of the revised Terms.
            </p>
          </Section>

          <Section title="2. About My Trail Log">
            <p>
              My Trail Log is a trail tracking platform that connects to your Strava account, analyses
              your GPS activity data, and tracks your progress along Britain&apos;s long-distance trails.
              The Service shows which sections of each trail you have covered and calculates your overall
              completion percentage.
            </p>
            <p>
              Optionally, with your permission, the Service can append trail progress information to the
              descriptions of your Strava activities.
            </p>
            <p>
              My Trail Log may offer both free and paid subscription tiers. Features available on each
              tier are described on the Service and may change over time.
            </p>
          </Section>

          <Section title="3. User responsibilities">
            <p>
              To use the Service you must connect a valid Strava account. You are responsible for
              maintaining the security of your account and for all activity that occurs under it.
            </p>
            <p>
              You must comply with{" "}
              <a href="https://www.strava.com/legal/terms" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava&apos;s Terms of Service
              </a>{" "}
              at all times. My Trail Log is not affiliated with or endorsed by Strava, Inc. You can
              revoke the Service&apos;s access to your Strava account at any time via your{" "}
              <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava connected apps settings
              </a>.
            </p>
            <p>
              You must provide accurate information where requested and must not impersonate any person
              or misrepresent your identity or affiliation.
            </p>
          </Section>

          <Section title="4. Acceptable use">
            <p>
              You agree to use the Service only for lawful purposes and in accordance with these Terms.
              You must not:
            </p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li>Attempt to access, query, or interfere with another user&apos;s data or account.</li>
              <li>Scrape, harvest, copy, or republish trail data, activity data, or any other content from the Service for any purpose outside your personal use.</li>
              <li>Use automated scripts, bots, or crawlers to interact with the Service.</li>
              <li>Attempt to overload, disrupt, reverse-engineer, or compromise the security of the Service or its infrastructure.</li>
              <li>Use the Service in any way that violates applicable local, national, or international law or regulation.</li>
              <li>Transmit any material that is unlawful, defamatory, or otherwise objectionable.</li>
            </ul>
            <p>
              We reserve the right to suspend or terminate access for any user who breaches these rules.
            </p>
          </Section>

          <Section title="5. Intellectual property">
            <p>
              The Service, including its software, design, trail matching algorithms, and all content
              produced by My Trail Log, is owned by or licensed to us and is protected by copyright and
              other intellectual property laws. Nothing in these Terms grants you any right to use our
              name, logo, or branding.
            </p>
            <p>
              Trail route data is derived from publicly available geographic datasets. My Trail Log does
              not claim ownership of underlying trail routes or any third-party data sources. Activity
              data accessed via Strava remains subject to Strava&apos;s terms and your rights as a Strava user.
            </p>
            <p>
              You retain all rights to your personal activity data. By using the Service, you grant us
              a limited licence to process that data solely for the purpose of providing the Service to you.
            </p>
          </Section>

          <Section title="6. Accuracy of trail data">
            <p>
              Trail route data is sourced from publicly available geographical datasets. While we aim
              for accuracy, we cannot guarantee that trail geometry precisely matches the current
              on-the-ground route of any trail. Routes change over time due to diversions, seasonal
              closures, and land access agreements.
            </p>
            <p>
              Progress calculations are estimates based on GPS data and a 50-metre matching tolerance.
              They should not be treated as a definitive record of completion for any official challenge
              or event. Always follow the official route guidance for the trail you are undertaking.
              The Service is not a substitute for appropriate navigation equipment, maps, or experience.
            </p>
          </Section>

          <Section title="7. Subscription and payment terms">
            <p>
              My Trail Log currently offers a free tier that provides access to core trail tracking
              features. Paid subscription tiers with additional features are coming soon.
            </p>
            <p>
              When paid subscriptions are introduced, the following terms will apply:
            </p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li>Subscription fees will be charged in advance on a recurring basis (monthly or annual, depending on the plan selected).</li>
              <li>All fees are stated inclusive or exclusive of VAT as indicated at the point of purchase.</li>
              <li>You may cancel your subscription at any time. Cancellation takes effect at the end of the current billing period; no partial refunds are issued for unused time unless required by law.</li>
              <li>We reserve the right to change subscription pricing with reasonable notice. Price changes will not affect your current billing period.</li>
              <li>If a payment fails, we may suspend access to paid features until payment is resolved.</li>
            </ul>
            <p>
              Nothing in this section affects any statutory rights you have as a consumer under
              applicable law, including rights under the Consumer Rights Act 2015.
            </p>
          </Section>

          <Section title="8. Privacy">
            <p>
              Your use of the Service is governed by our{" "}
              <Link href="/privacy" className="text-[#C4652A] underline hover:no-underline">Privacy Policy</Link>,
              which describes how we collect, store, and process your personal data. By using the Service,
              you acknowledge that you have read and understood our Privacy Policy.
            </p>
          </Section>

          <Section title="9. Disclaimers">
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranty
              of any kind, whether express or implied, including but not limited to implied warranties of
              merchantability, fitness for a particular purpose, or non-infringement. We do not warrant
              that the Service will be uninterrupted, error-free, or free of harmful components.
            </p>
            <p>
              Trail progress data is provided for personal reference only and must not be relied upon
              for navigation, safety decisions, or as evidence of completion for any official challenge
              or award scheme.
            </p>
          </Section>

          <Section title="10. Limitation of liability">
            <p>
              To the fullest extent permitted by applicable law, My Trail Log and its operators shall
              not be liable for any indirect, incidental, special, consequential, or punitive damages
              arising out of or in connection with your use of, or inability to use, the Service. This
              includes but is not limited to loss of data, loss of profit, incorrect trail progress
              calculations, or any reliance on the Service for navigation or safety purposes.
            </p>
            <p>
              Where liability cannot be excluded by law, our total aggregate liability to you in respect
              of any claim arising under or in connection with these Terms shall not exceed the total
              fees paid by you to us in the twelve months preceding the event giving rise to the claim,
              or £100, whichever is greater.
            </p>
            <p>
              Nothing in these Terms excludes or limits liability for death or personal injury caused
              by negligence, fraud or fraudulent misrepresentation, or any other liability that cannot
              lawfully be excluded.
            </p>
          </Section>

          <Section title="11. Modification and discontinuation of the service">
            <p>
              We reserve the right to modify, suspend, or discontinue the Service (or any part of it)
              at any time, with or without notice. We may also introduce, change, or remove features,
              including moving features between free and paid tiers.
            </p>
            <p>
              Where we discontinue a paid subscription tier, we will provide reasonable advance notice
              and offer a pro-rata refund for any prepaid subscription period that cannot be fulfilled.
            </p>
            <p>
              We shall not be liable to you or any third party for any modification, suspension, or
              discontinuation of the Service.
            </p>
          </Section>

          <Section title="12. Governing law and disputes">
            <p>
              These Terms and any dispute or claim arising out of or in connection with them (including
              non-contractual disputes) shall be governed by and construed in accordance with the laws
              of England and Wales.
            </p>
            <p>
              You and we both agree to submit to the exclusive jurisdiction of the courts of England
              and Wales to resolve any legal dispute arising in connection with these Terms, unless
              you are a consumer resident in Scotland or Northern Ireland, in which case you may also
              bring proceedings in the courts of your country of residence.
            </p>
          </Section>

          <Section title="13. Contact">
            <p>
              If you have any questions about these Terms or the Service, please contact us at{" "}
              <a href="mailto:mytrailloguk@gmail.com" className="text-[#C4652A] underline hover:no-underline">
                mytrailloguk@gmail.com
              </a>.
            </p>
          </Section>

        </div>
      </main>

      {/* Footer */}
      <footer className="bg-[#2C2520] border-t border-white/10 py-7 px-6">
        <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-[#FAF8F5]/50">
            <LogoIcon className="w-4 h-4 text-[#C4652A]" />
            <span className="text-sm font-medium">My Trail Log</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/strava/api_logo_pwrdBy_strava_horiz_white.svg"
            alt="Powered by Strava"
            style={{ height: "20px", width: "auto", opacity: 0.7 }}
          />
          <div className="flex items-center gap-4 text-[#FAF8F5]/30 text-xs">
            <Link href="/privacy" className="hover:text-[#FAF8F5]/60 transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-[#FAF8F5]/60 transition-colors">Terms of Service</Link>
            <Link href="/support" className="hover:text-[#FAF8F5]/60 transition-colors">Support</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
