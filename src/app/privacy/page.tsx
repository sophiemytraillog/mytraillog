import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — My Trail Log",
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

export default function PrivacyPage() {
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
            <h1 className="text-3xl font-extrabold text-[#2C2520] tracking-tight mb-2">Privacy Policy</h1>
            <p className="text-[#8A7F72] text-sm">Last updated: 20 August 2026</p>
          </div>

          <Section title="Overview">
            <p>
              My Trail Log (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) is a trail tracking service that helps
              you track your progress along Britain&apos;s long-distance trails using your Strava activity data.
              This policy explains what data we collect, how we use it, and your rights regarding it.
            </p>
            <p>
              We take your privacy seriously. We collect only what we need to provide the service, we never
              sell your data, and you can request deletion at any time.
            </p>
          </Section>

          <Section title="Data we collect">
            <p>When you connect your Strava account we request read access to your activities. We store the following:</p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li><span className="font-medium text-[#2C2520]">Strava profile information</span> — your name, Strava username, and profile picture URL, so we can display your account in the dashboard.</li>
              <li><span className="font-medium text-[#2C2520]">Activity metadata</span> — the name, type (run, walk, hike, etc.), date, and distance of each activity.</li>
              <li><span className="font-medium text-[#2C2520]">GPS route data</span> — the encoded polyline of each activity, which we decode into a geometry stored in our database. This is the GPS trace of where you went.</li>
            </ul>
            <p>
              We do not collect your heart rate, power data, photos, comments, kudos, or any other
              Strava data beyond what is listed above.
            </p>
            <p>
              If you grant <span className="font-medium text-[#2C2520]">activity:write</span> permission (optional, for automatic
              description updates), we also store a record of which activities have had their descriptions updated,
              but we do not store the description text itself.
            </p>
          </Section>

          <Section title="Why we collect it">
            <p>
              The GPS geometry of your activities is the core of the service. We compare it spatially
              against the official routes of Britain&apos;s long-distance trails to calculate how much of
              each trail you have covered, which sections you&apos;ve completed, and your overall progress.
            </p>
            <p>
              Profile information and activity metadata are used solely to display your dashboard, identify
              your account, and present your activity history in a meaningful way.
            </p>
            <p>We do not use your data for advertising, profiling, or any purpose beyond providing the trail-tracking service.</p>
            <p>
              We do not use your Strava data to train, develop, evaluate, or operate any
              artificial intelligence or machine learning models.
            </p>
          </Section>

          <Section title="Legal basis for processing">
            <p>
              Our legal basis for processing your personal data is <span className="font-medium text-[#2C2520]">consent</span>,
              as defined under UK GDPR Article 6(1)(a). You provide this consent explicitly when you click
              &ldquo;Connect with Strava&rdquo; and authorise the OAuth permission screen that Strava presents.
            </p>
            <p>
              You can withdraw consent at any time by disconnecting My Trail Log from your Strava account
              in <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">Strava&apos;s connected apps settings</a>,
              which deletes your data immediately and automatically (see below) — no separate request needed.
            </p>
          </Section>

          <Section title="How long we keep your data">
            <p>
              We retain your data for as long as your account is active — that is, as long as you continue
              to use the service. If you have not logged in or synced your activities for 12 months, we
              may delete your account and associated data.
            </p>
            <p>
              If you revoke My Trail Log&apos;s access in{" "}
              <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava&apos;s connected apps settings
              </a>{" "}
              — or use the <span className="font-medium text-[#2C2520]">Disconnect &amp; Delete My Data</span> button
              in the app — your data is deleted <span className="font-medium text-[#2C2520]">immediately and automatically</span>.
              There is no waiting period and no separate request needed for this path.
            </p>
            <p>
              If you instead request deletion by emailing us (see below), we will complete that
              within 30 days.
            </p>
            <p>
              Anonymised, aggregate statistics (e.g. total number of users who have walked the Pennine Way)
              that cannot be linked to any individual may be retained indefinitely.
            </p>
          </Section>

          <Section title="Data sharing and third parties">
            <p>
              We do not sell, rent, or share your personal data with any third parties for their own purposes.
            </p>
            <p>Your data is processed by the following sub-processors solely to operate the service:</p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li><span className="font-medium text-[#2C2520]">Supabase</span> — our database host (PostgreSQL, hosted in the EU). Your GPS and activity data is stored here.</li>
              <li><span className="font-medium text-[#2C2520]">Strava</span> — the source of your data. We interact with the Strava API to read your activities. Strava&apos;s own privacy policy governs your relationship with Strava.</li>
            </ul>
            <p>
              We do not use Google Analytics, Meta Pixel, or any other third-party tracking or advertising services.
            </p>
          </Section>

          <Section title="Cookies">
            <p>We use two session cookies, both of which are essential to the operation of the service:</p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li>
                <span className="font-mono text-xs bg-[#EAE4DA] px-1.5 py-0.5 rounded text-[#2C2520]">strava_user_id</span>
                {" "}— stores your internal user ID to keep you logged in across page loads.
              </li>
              <li>
                <span className="font-mono text-xs bg-[#EAE4DA] px-1.5 py-0.5 rounded text-[#2C2520]">strava_athlete</span>
                {" "}— caches your Strava profile name and avatar so the dashboard loads quickly without an API call.
              </li>
            </ul>
            <p>
              Both cookies are session-scoped and contain no tracking information. We do not use any
              analytics, advertising, or third-party cookies.
            </p>
          </Section>

          <Section title="Your rights">
            <p>Under UK GDPR you have the right to:</p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li><span className="font-medium text-[#2C2520]">Access</span> the personal data we hold about you.</li>
              <li><span className="font-medium text-[#2C2520]">Rectification</span> of inaccurate data (though most data comes directly from Strava).</li>
              <li><span className="font-medium text-[#2C2520]">Erasure</span> — request that we delete your account and all associated data.</li>
              <li><span className="font-medium text-[#2C2520]">Portability</span> — receive a copy of your data in a machine-readable format.</li>
              <li><span className="font-medium text-[#2C2520]">Withdraw consent</span> at any time, which will not affect the lawfulness of processing before withdrawal.</li>
            </ul>
          </Section>

          <Section title="Requesting deletion">
            <p>
              The fastest way to delete your data is to disconnect My Trail Log via{" "}
              <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Strava&apos;s connected apps settings
              </a>{" "}
              or the <span className="font-medium text-[#2C2520]">Disconnect &amp; Delete My Data</span> button in
              the app — this deletes your data immediately and automatically, with nothing further to do.
            </p>
            <p>
              If you&apos;d rather request deletion directly (for example, if you no longer have
              access to your Strava account), email us at{" "}
              <a href="mailto:mytrailloguk@gmail.com" className="text-[#C4652A] underline hover:no-underline">
                mytrailloguk@gmail.com
              </a>{" "}
              with the subject line <span className="font-medium text-[#2C2520]">Delete my account</span> and
              include your Strava username or email address so we can identify your account. We will
              confirm receipt within 5 working days and complete deletion within 30 days.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              If you have any questions about this privacy policy or how we handle your data, please email{" "}
              <a href="mailto:mytrailloguk@gmail.com" className="text-[#C4652A] underline hover:no-underline">
                mytrailloguk@gmail.com
              </a>.
            </p>
            <p>
              If you are unhappy with how we handle your data and we have not resolved your concern, you
              have the right to lodge a complaint with the{" "}
              <a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                Information Commissioner&apos;s Office (ICO)
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
