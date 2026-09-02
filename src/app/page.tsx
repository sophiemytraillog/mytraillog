import ConnectStrava from "./ConnectStrava";

const steps = [
  {
    number: "01",
    title: "Connect Strava",
    description:
      "Link your Strava account with one click. We only ever read your activity data - we never post or modify anything.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-7 h-7"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
        />
      </svg>
    ),
  },
  {
    number: "02",
    title: "We match your activities",
    description:
      "Our algorithm maps your GPS routes against the official lines of Britain's national trails, segment by segment.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-7 h-7"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
      </svg>
    ),
  },
  {
    number: "03",
    title: "See your progress on a map",
    description:
      "View an interactive map showing every section you've covered and exactly what's still waiting for you.",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="w-7 h-7"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
    ),
  },
];

const trails = [
  { name: "South Downs Way", region: "South England", miles: 100, terrain: "Chalk downland & coast" },
  { name: "Pennine Way", region: "Northern England", miles: 268, terrain: "Moorland & high peaks" },
  { name: "West Highland Way", region: "Scotland", miles: 96, terrain: "Highland glen & lochside" },
  { name: "Coast to Coast", region: "Northern England", miles: 192, terrain: "Lakes, dales & moors" },
  { name: "Offa's Dyke Path", region: "Wales & Borders", miles: 177, terrain: "Hills & river valleys" },
  { name: "North Downs Way", region: "South England", miles: 153, terrain: "Woodland & farmland" },
];

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 101.06-1.061l-8.689-8.69a2.25 2.25 0 00-3.182 0l-8.69 8.69a.75.75 0 101.061 1.06l8.69-8.689z" />
      <path d="M12 5.432l8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75V21a.75.75 0 01-.75.75H5.625a1.875 1.875 0 01-1.875-1.875v-6.198c.03-.028.061-.056.091-.086L12 5.432z" />
    </svg>
  );
}

function GetStartedLink() {
  return (
    <a
      href="#get-started"
      className="inline-block px-8 py-3.5 rounded-xl bg-[#C4652A] text-white font-semibold hover:bg-[#C4652A]/90 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
    >
      Connect with Strava - free for 1 month
    </a>
  );
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Strava connection cancelled - no changes were made.",
  invalid_state: "Your session expired before Strava could connect - please try again.",
  no_code: "Strava didn't send back the expected authorisation - please try again.",
  token_exchange_failed: "We couldn't complete the connection with Strava - please try again.",
};

function ConnectErrorBanner({ error }: { error?: string }) {
  if (!error) return null;
  const message = OAUTH_ERROR_MESSAGES[error] ?? "Something went wrong connecting to Strava - please try again.";
  return (
    <div className="max-w-lg mx-auto mb-8 px-4 py-3 rounded-xl bg-[#C4652A]/10 border border-[#C4652A]/20 text-[#C4652A] text-sm text-center">
      {message}
    </div>
  );
}

function DeletedBanner({ deleted }: { deleted?: string }) {
  if (deleted !== "true") return null;
  return (
    <div className="max-w-lg mx-auto mb-8 px-4 py-3 rounded-xl bg-[#4A7C59]/10 border border-[#4A7C59]/20 text-[#4A7C59] text-sm text-center">
      Your data has been deleted and Strava access revoked. Sorry to see you go.
    </div>
  );
}

export default function Home({
  searchParams,
}: {
  searchParams?: { error?: string; deleted?: string };
}) {
  return (
    <div className="min-h-screen">
      {/* ── Navigation ─────────────────────────────────────────── */}
      <nav className="px-6 py-5 flex items-center border-b border-[#E5DED4]">
        <div className="flex items-center gap-2 text-[#2C2520]">
          <LogoIcon className="w-5 h-5 text-[#C4652A]" />
          <span className="font-semibold text-base tracking-tight">My Trail Log</span>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className="relative py-24 md:py-32 flex flex-col justify-center overflow-hidden">
        {/* Subtle warm radial glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 40%, rgba(196,101,42,0.07) 0%, transparent 70%)",
          }}
        />

        {/* Topographic ring pattern */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.04]"
          style={{
            backgroundImage:
              "repeating-radial-gradient(circle at 65% 40%, transparent 0px, transparent 34px, rgba(44,37,32,1) 35px, transparent 36px), repeating-radial-gradient(circle at 35% 60%, transparent 0px, transparent 54px, rgba(44,37,32,1) 55px, transparent 56px)",
          }}
        />

        {/* Hero content */}
        <div className="relative z-10 text-center px-6 max-w-4xl mx-auto">
          <ConnectErrorBanner error={searchParams?.error} />
          <DeletedBanner deleted={searchParams?.deleted} />

          <div className="inline-flex items-center gap-2 bg-[#C4652A]/10 border border-[#C4652A]/20 text-[#C4652A] text-xs font-semibold tracking-[0.12em] uppercase px-4 py-2 rounded-full mb-8">
            <span className="w-1.5 h-1.5 bg-[#C4652A] rounded-full inline-block" />
            Britain&apos;s long-distance trail tracker
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-[5.25rem] font-extrabold text-[#2C2520] leading-[1.04] tracking-tight mb-6">
            See how much of<br />
            Britain&apos;s greatest trails<br />
            you&apos;ve already completed
          </h1>

          <p className="text-[#8A7F72] text-lg md:text-xl max-w-lg mx-auto mb-10 leading-relaxed">
            Connect your Strava account and My Trail Log automatically maps your progress across the
            UK&apos;s National Trails and 1,000+ long-distance paths. No extra tracking needed - we match
            your existing activities.
          </p>

          <ConnectStrava />
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-[#E5DED4]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-[#2C2520] mb-3 tracking-tight">
              How it works
            </h2>
            <p className="text-[#8A7F72] text-lg">Three simple steps to see your trail story</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8 relative">
            {/* Connector line (desktop only) */}
            <div className="hidden md:block absolute top-7 left-[calc(16.66%+1.75rem)] right-[calc(16.66%+1.75rem)] h-px bg-[#E5DED4]" />

            {steps.map((step) => (
              <div key={step.number} className="flex flex-col items-center text-center">
                <div className="relative mb-5">
                  <div className="w-14 h-14 rounded-2xl bg-[#C4652A]/10 text-[#C4652A] flex items-center justify-center">
                    {step.icon}
                  </div>
                </div>
                <div className="text-[11px] font-bold text-[#C4652A] tracking-[0.15em] uppercase mb-2">
                  Step {step.number}
                </div>
                <h3 className="text-lg font-bold text-[#2C2520] mb-2">{step.title}</h3>
                <p className="text-[#8A7F72] text-sm leading-relaxed max-w-xs">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Trails preview ──────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-[#E5DED4]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-[#2C2520] mb-3 tracking-tight">
              Britain&apos;s great trails, tracked
            </h2>
            <p className="text-[#8A7F72] text-lg">
              We cover all the major UK national trails and long-distance routes
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {trails.map((trail) => (
              <div
                key={trail.name}
                className="bg-white rounded-2xl p-5 border border-[#E5DED4] hover:border-[#C4652A]/40 hover:shadow-md transition-all duration-200 group"
              >
                <div className="flex items-start justify-between mb-1">
                  <h3 className="font-semibold text-[#2C2520] text-[15px] leading-snug">{trail.name}</h3>
                  <span className="text-[11px] font-medium text-[#8A7F72] bg-[#EAE4DA] px-2 py-0.5 rounded-full whitespace-nowrap ml-2 shrink-0">
                    {trail.miles} mi
                  </span>
                </div>
                <p className="text-xs text-[#8A7F72] mb-1">{trail.region}</p>
                <p className="text-xs text-[#8A7F72]/60 mb-4 italic">{trail.terrain}</p>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-[#8A7F72]">Completion</span>
                    <span className="text-[#8A7F72]/60 group-hover:text-[#4A7C59] transition-colors text-[11px]">
                      Connect Strava to see
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#EAE4DA] rounded-full overflow-hidden">
                    <div className="h-full w-0 bg-[#4A7C59] rounded-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────── */}
      <section
        className="relative py-28 px-6 text-center"
        style={{ background: "#2C2520" }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(196,101,42,0.15) 0%, transparent 70%)",
          }}
        />
        <div className="relative max-w-xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight leading-tight">
            Ready to discover<br />your trail story?
          </h2>
          <p className="text-[#FAF8F5]/60 mb-9 text-lg leading-relaxed">
            Your Strava activities are already out there. Let&apos;s see which trails you&apos;ve conquered.
          </p>
          <GetStartedLink />
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="bg-[#2C2520] border-t border-white/10 py-7 px-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
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
          <div className="flex flex-col sm:items-end gap-1.5">
            <div className="flex items-center gap-4 text-[#FAF8F5]/40 text-xs">
              <a href="/privacy" className="hover:text-[#FAF8F5]/70 transition-colors">Privacy Policy</a>
              <a href="/terms" className="hover:text-[#FAF8F5]/70 transition-colors">Terms of Service</a>
            </div>
            <p className="text-[#FAF8F5]/20 text-xs text-center sm:text-right">
              Not affiliated with Strava, Inc.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
