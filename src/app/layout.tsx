import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { DistanceUnitProvider } from "./DistanceUnitProvider";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "My Trail Log - Track Britain's great trails with Strava",
  description: "Connect your Strava account and discover how much of the UK's iconic long-distance paths you've already covered.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <DistanceUnitProvider>{children}</DistanceUnitProvider>
        <footer className="text-center py-3 text-[10px] text-[#8A7F72]/40">
          Background{" "}
          <a
            href="https://www.freepik.com/author/kjpargeter"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[#8A7F72]/70 underline underline-offset-2 transition-colors"
          >
            designed by kjpargeter / Freepik
          </a>
        </footer>
      </body>
    </html>
  );
}
