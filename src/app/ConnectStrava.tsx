export default function ConnectStrava() {
  return (
    <div id="get-started" className="max-w-sm mx-auto scroll-mt-10">
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
