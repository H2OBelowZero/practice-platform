// A template (unlike a layout) remounts on every navigation, so each page settles in once: continuity, not decoration (globals.css .page-enter).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
