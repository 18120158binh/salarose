// The Salarose mark: a rose-sun half disc on a white horizon line, its reflection below, on a teal tile.
export function SalaroseMark() {
  return (
    <span aria-hidden className="flex size-12 items-center justify-center rounded-card bg-primary">
      <svg fill="none" height="26" viewBox="0 0 14 14" width="26">
        <path className="fill-rose-sun" d="M3 8a4 4 0 0 1 8 0Z" />
        <path className="fill-rose-sun" d="M3 8a4 4 0 0 0 8 0Z" opacity=".45" />
        <path d="M1.5 8h11" stroke="#ffffff" strokeLinecap="round" strokeWidth="1.1" />
      </svg>
    </span>
  );
}

// The rose sun on the horizon behind the sign-in card. Decoration only: no text, no control.
export function Horizon() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full"
      data-testid="horizon"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1440 900"
    >
      <path className="fill-rose-sun" d="M1060 504a120 120 0 0 1 240 0Z" opacity=".85" />
      <path className="fill-rose-sun" d="M1060 504a120 120 0 0 0 240 0Z" opacity=".22" />
      <path d="M0 504h1440" stroke="#ffffff" strokeWidth="2" />
    </svg>
  );
}
