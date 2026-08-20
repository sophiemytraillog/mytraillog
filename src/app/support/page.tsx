import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support — My Trail Log",
};

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 101.06-1.061l-8.689-8.69a2.25 2.25 0 00-3.182 0l-8.69 8.69a.75.75 0 101.061 1.06l8.69-8.689z" />
      <path d="M12 5.432l8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75V21a.75.75 0 01-.75.75H5.625a1.875 1.875 0 01-1.875-1.875v-6.198c.03-.028.061-.056.091-.086L12 5.432z" />
    </svg>
  );
}

function Faq({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div className="py-4 border-b border-[#E5DED4] last:border-0">
      <p className="text-sm font-semibold text-[#2C2520] mb-1.5">{question}</p>
      <div className="text-sm text-[#2C2520]/75 leading-relaxed">{children}</div>
    </div>
  );
}

export default function SupportPage() {
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
              Help
            </div>
            <h1 className="text-3xl font-extrabold text-[#2C2520] tracking-tight mb-3">Support</h1>
            <p className="text-[#2C2520]/75 text-sm leading-relaxed">
              We&apos;re here to help. If you can&apos;t find an answer below, get in touch and we&apos;ll get back to you.
            </p>
          </div>

          {/* Contact card */}
          <div className="bg-white border border-[#E5DED4] rounded-2xl px-5 py-5 mb-10">
            <p className="text-xs font-semibold tracking-widest uppercase text-[#8A7F72] mb-3">Contact us</p>
            <a
              href="mailto:mytrailloguk@gmail.com"
              className="text-[#C4652A] font-medium text-sm underline underline-offset-2 hover:no-underline"
            >
              mytrailloguk@gmail.com
            </a>
            <p className="text-[#8A7F72] text-xs mt-1.5">We aim to respond within 48 hours.</p>
          </div>

          {/* FAQs */}
          <section>
            <h2 className="text-lg font-bold text-[#2C2520] mb-1 pb-2 border-b border-[#E5DED4]">
              Frequently asked questions
            </h2>

            <Faq question="How do I connect my Strava account?">
              <p>
                From the My Trail Log home page, click <span className="font-medium text-[#2C2520]">Connect with Strava</span>.
                You&apos;ll be taken to Strava to authorise access — once you approve, you&apos;ll be redirected straight
                to your dashboard and your activities will begin syncing.
              </p>
            </Faq>

            <Faq question="Why are some of my activities not matching trails?">
              <p>
                Activities are matched when your GPS track passes within 50 metres of the official trail route.
                A few common reasons an activity might not match:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1 pl-1">
                <li>The activity was recorded without GPS (e.g. a manual entry or indoor activity).</li>
                <li>Your route ran parallel to but not close enough to the trail line.</li>
                <li>The activity type is not included in your sync settings — check whether cycle rides are enabled if relevant.</li>
              </ul>
              <p className="mt-2">
                If you&apos;ve recently synced and an activity still isn&apos;t showing, try clicking <span className="font-medium text-[#2C2520]">Sync Activities</span> again
                from the dashboard.
              </p>
            </Faq>

            <Faq question="How do I delete my account and data?">
              <p>
                The fastest way is to disconnect My Trail Log via your{" "}
                <a href="https://www.strava.com/settings/apps" target="_blank" rel="noopener noreferrer" className="text-[#C4652A] underline hover:no-underline">
                  Strava connected apps settings
                </a>{" "}
                or the <span className="font-medium text-[#2C2520]">Disconnect &amp; Delete My Data</span> button
                in the app — either one deletes all your data immediately and automatically, no email required.
              </p>
              <p className="mt-2">
                Alternatively, email us at{" "}
                <a href="mailto:mytrailloguk@gmail.com" className="text-[#C4652A] underline hover:no-underline">
                  mytrailloguk@gmail.com
                </a>{" "}
                with the subject line <span className="font-medium text-[#2C2520]">Delete my account</span> and include
                your Strava username so we can identify your account. We will confirm receipt within 5 working days
                and delete all your data within 30 days.
              </p>
            </Faq>

            <Faq question="Why is my completion percentage different from what I expected?">
              <p>
                Completion is calculated from the GPS tracks of your synced Strava activities, compared against the
                official trail geometry. A few things to be aware of:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1 pl-1">
                <li>Only activities synced to My Trail Log count — if you walked a section before connecting, sync your full activity history first.</li>
                <li>Progress is based on distance covered along the official route, not straight-line distance.</li>
                <li>Official trail routes are occasionally updated to reflect diversions or seasonal changes, which can affect percentages.</li>
              </ul>
            </Faq>

          </section>

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
