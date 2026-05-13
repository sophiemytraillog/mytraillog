"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[#FAF8F5]">
      <div className="text-center">
        <p className="text-red-500 text-sm font-medium mb-2">Dashboard error</p>
        <p className="text-[#8A7F72] text-sm mb-4">{error.message}</p>
        <button onClick={reset}
          className="text-[#C4652A] text-sm underline underline-offset-2">
          Try again
        </button>
      </div>
    </div>
  );
}
