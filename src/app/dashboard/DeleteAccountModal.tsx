"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onClose: () => void;
}

const CONFIRM_WORD = "DELETE";

export default function DeleteAccountModal({ onClose }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !deleting) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, deleting]);

  async function handleDelete() {
    if (confirmText !== CONFIRM_WORD) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      if (!res.ok) throw new Error("Request failed");
      // Full navigation, not router.push — cookies were just cleared
      // server-side and every server component's auth check needs to see
      // that on a fresh request, not stale client-side router state.
      window.location.href = "/?deleted=true";
    } catch {
      setError("Something went wrong deleting your data. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      onClick={() => !deleting && onClose()}
    >
      <div className="absolute inset-0 bg-black/30" />

      <div
        className="relative bg-white rounded-2xl border border-[#E5DED4] w-full max-w-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5DED4]">
          <h2 className="text-sm font-semibold text-[#C4652A]">Disconnect &amp; Delete My Data</h2>
          {!deleting && (
            <button
              onClick={onClose}
              className="text-[#8A7F72] hover:text-[#2C2520] transition-colors"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div className="bg-[#C4652A]/5 border border-[#C4652A]/20 rounded-lg px-3.5 py-3">
            <p className="text-xs text-[#2C2520] leading-relaxed">
              This <strong>permanently deletes</strong> all your data from My Trail Log, including:
            </p>
            <ul className="text-xs text-[#2C2520] leading-relaxed list-disc pl-4 mt-1.5 space-y-0.5">
              <li>Your activity history</li>
              <li>Trail progress and completion percentages</li>
              <li>Manually filled gaps and marked sections</li>
              <li>Any other cached data linked to your account</li>
            </ul>
            <p className="text-xs text-[#2C2520] leading-relaxed mt-2">
              We&apos;ll also revoke My Trail Log&apos;s access on Strava. This can&apos;t be undone.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#2C2520] mb-1">
              Type <strong>{CONFIRM_WORD}</strong> to confirm
            </label>
            <input
              ref={inputRef}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={deleting}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 focus:outline-none focus:border-[#C4652A]/50 disabled:opacity-50"
            />
          </div>

          {error && <p className="text-xs text-[#C4652A]">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleDelete}
              disabled={confirmText !== CONFIRM_WORD || deleting}
              className="px-4 py-2 bg-[#C4652A] text-white text-xs font-medium rounded-lg hover:bg-[#B05A25] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {deleting ? "Deleting…" : "Permanently delete my data"}
            </button>
            {!deleting && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs text-[#8A7F72] hover:text-[#2C2520] transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
