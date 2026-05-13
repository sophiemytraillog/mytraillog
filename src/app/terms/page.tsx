import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — My Trail Log",
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
            <p className="text-[#8A7F72] text-sm">Last updated: 7 May 2026</p>
          </div>

          <Section title="Acceptance of terms">
            <p>
              By connecting your Strava account and using My Trail Log (&ldquo;the service&rdquo;, &ldquo;we&rdquo;,
              &ldquo;us&rdquo;), you agree to these Terms of Service. If you do not agree, please do not use the service.
            </p>
            <p>
              My Trail Log is a personal project, not a commercial product. It is provided free of charge
              and on a best-efforts basis.
            </p>
          </Section>

          <Section title="What the service does">
            <p>
              My Trail Log connects to your Strava account (with your permission), reads your activity GPS data,
              and compares it against the official routes of Britain&apos;s long-distance trails. It shows you
              which sections of each trail you have covered and calculates your overall progress.
            </p>
            <p>
              Optionally, with additional Strava write permission, the service can append trail progress
              information to the descriptions of your Strava activities.
            </p>
          </Section>

          <Section title="Strava account requirement">
            <p>
              The service requires a valid Strava account. You must comply with{" "}
              <a href="https://www.strava.com/legal/terms" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava&apos;s Terms of Service
              </a>{" "}
              when using My Trail Log. We are not affiliated with or endorsed by Strava, Inc.
            </p>
            <p>
              Access to your Strava data is controlled entirely by Strava&apos;s OAuth system. You can revoke
              access at any time from your{" "}
              <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava connected apps settings
              </a>.
            </p>
          </Section>

          <Section title="Acceptable use">
            <p>You agree to use the service only for its intended purpose — tracking your personal trail progress. You must not:</p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li>Attempt to access other users&apos; data.</li>
              <li>Use the service to scrape, harvest, or aggregate trail or activity data for any other purpose.</li>
              <li>Attempt to overload, disrupt, or reverse-engineer the service.</li>
              <li>Use automated scripts or bots to interact with the service.</li>
            </ul>
          </Section>

          <Section title="Accuracy of trail data">
            <p>
              Trail route data is sourced from publicly available geographical datasets. While we aim
              for accuracy, we cannot guarantee that the trail geometry precisely matches the current
              on-the-ground route of any trail. Routes change over time due to diversions, seasonal closures,
              and land access agreements.
            </p>
            <p>
              Progress calculations are estimates based on GPS data and a 50-metre matching tolerance.
              They should not be used as a definitive record of completion for any official challenge or
              event. Always follow the official route guidance for the trail you are walking.
            </p>
          </Section>

          <Section title="Privacy">
            <p>
              Your use of the service is also governed by our{" "}
              <Link href="/privacy" className="text-[#C4652A] underline hover:no-underline">Privacy Policy</Link>,
              which describes how we collect, store, and use your data.
            </p>
          </Section>

          <Section title="Disclaimers">
            <p>
              The service is provided &ldquo;as is&rdquo; without warranty of any kind. We do not guarantee
              that it will be available at all times, error-free, or that progress calculations will be
              perfectly accurate.
            </p>
            <p>
              Trail progress shown in the service is for personal reference only. It is not a substitute
              for navigation equipment, proper trail maps, or physical fitness assessment. Always plan
              outdoor activities appropriately and follow the Countryside Code.
            </p>
          </Section>

          <Section title="Limitation of liability">
            <p>
              To the fullest extent permitted by law, My Trail Log shall not be liable for any indirect,
              incidental, or consequential damages arising from your use of the service, including but
              not limited to loss of data, incorrect trail progress calculations, or reliance on the
              service for navigation.
            </p>
          </Section>

          <Section title="Changes to these terms">
            <p>
              We may update these terms from time to time. We will update the &ldquo;Last updated&rdquo;
              date at the top of this page when we do. Continued use of the service after changes
              constitutes acceptance of the revised terms.
            </p>
          </Section>

          <Section title="Governing law">
            <p>
              These terms are governed by the laws of England and Wales. Any disputes will be subject
              to the exclusive jurisdiction of the courts of England and Wales.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about these terms can be sent to{" "}
              <a href="mailto:privacy@mytraillog.app" className="text-[#C4652A] underline hover:no-underline">
                privacy@mytraillog.app
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
          </div>
        </div>
      </footer>
    </div>
  );
}
