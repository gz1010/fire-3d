// The Fire-3d mark (brief 4 handoff, every screen's top bar): a mountain outline in light grey with an orange flame
// at its foot. Shared by the map workspace's top bar and the Forensic header (re-exported from ui/Header.tsx).
// `size` is the width in px; the mark is 26:22. Decorative: the "Fire-3d" name next to it is the text.

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round((size * 22) / 26)} viewBox="0 0 26 22" aria-hidden className="logo">
      <path d="M1 20 L9 6 L14 13 L18 7 L25 20 Z" fill="none" stroke="#d0d0d0" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13 20 C10 17 12 14 14 12 C14 15 17 16 16 20 Z" fill="#ff6a2a" />
    </svg>
  )
}
