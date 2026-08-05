"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  initialName?: string;
  onClose: () => void;
}

export default function RequestTrailModal({ initialName = "", onClose }: Props) {
  const [name, setName]       = useState(initialName);
  const [region, setRegion]   = useState("");
  const [url, setUrl]         = useState("");
  const [notes, setNotes]     = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/trail-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trail_name: name.trim(), region, url, notes }),
      });
      if (!res.ok) throw new Error("Request failed");
      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/*
        Leaflet's own panes/controls use z-index up to 1000 (see
        leaflet/dist/leaflet.css — .leaflet-pane: 400-700, .leaflet-top/
        .leaflet-bottom controls: 1000), well above Tailwind's z-50 this
        modal used before. z-[9999] on this fixed, full-viewport wrapper
        clears all of that, and the backdrop below inherits the same
        stacking context so it covers the map too, not just the modal card.
      */}
      <div className="absolute inset-0 bg-black/30" />

      <div
        className="relative bg-white rounded-2xl border border-[#E5DED4] w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5DED4]">
          <h2 className="text-sm font-semibold text-[#2C2520]">Request a trail</h2>
          <button
            onClick={onClose}
            className="text-[#8A7F72] hover:text-[#2C2520] transition-colors"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {submitted ? (
          <div className="px-5 py-8 text-center">
            <div className="w-10 h-10 rounded-full bg-[#4A7C59]/10 flex items-center justify-center mx-auto mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-[#4A7C59]">
                <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-sm font-medium text-[#2C2520] mb-1">
              Thanks! We&apos;ll review your request and try to add it soon.
            </p>
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 bg-[#C4652A] text-white text-xs font-medium rounded-lg hover:bg-[#B05A25] transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3.5">
            <p className="text-xs text-[#8A7F72] leading-relaxed">
              Can&apos;t find a trail? Let us know and we&apos;ll add it.
            </p>

            <div>
              <label className="block text-xs font-medium text-[#2C2520] mb-1">
                Trail name <span className="text-[#C4652A]">*</span>
              </label>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="e.g. Wealdway"
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 focus:outline-none focus:border-[#C4652A]/50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#2C2520] mb-1">
                Region / location
              </label>
              <input
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="e.g. Kent, East Sussex"
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 focus:outline-none focus:border-[#C4652A]/50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#2C2520] mb-1">
                Link
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. trail website or OS Maps URL"
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 focus:outline-none focus:border-[#C4652A]/50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#2C2520] mb-1">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any other details..."
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 focus:outline-none focus:border-[#C4652A]/50 resize-none"
              />
            </div>

            {error && (
              <p className="text-xs text-[#C4652A]">{error}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="px-4 py-2 bg-[#C4652A] text-white text-xs font-medium rounded-lg hover:bg-[#B05A25] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? "Submitting…" : "Submit request"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs text-[#8A7F72] hover:text-[#2C2520] transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
