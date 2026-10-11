import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 py-6">
      <header className="mb-6">
        <Link href="/" className="font-semibold underline-offset-4 hover:underline">Practice Platform</Link>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="mt-8 border-t border-neutral-500 pt-4 text-sm">
        <p>If you are in crisis call SADAG 0800 567 567 or go to the nearest emergency room. This site is not an emergency service.</p>
      </footer>
    </div>
  );
}
