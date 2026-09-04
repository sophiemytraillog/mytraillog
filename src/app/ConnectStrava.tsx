export default function ConnectStrava() {
  return (
    <div id="get-started" className="max-w-sm mx-auto scroll-mt-10">
      {/* The official Strava-branded button below is the actual OAuth
          trigger — its "Connect with Strava" text is baked into Strava's
          own SVG asset and can't be edited (required for API brand
          compliance), so the requested CTA copy sits as a heading above it
          instead. */}
      <p className="text-[#2C2520] font-semibold text-sm mb-3">
        Connect with Strava
      </p>
      <a
        href="/api/auth/strava"
        className="inline-block hover:-translate-y-0.5 active:translate-y-0 transition-transform duration-200"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/strava/btn_strava_connect_with_orange.svg"
          alt="Connect with Strava"
          style={{ height: "48px", width: "auto" }}
        />
      </a>
    </div>
  );
}
