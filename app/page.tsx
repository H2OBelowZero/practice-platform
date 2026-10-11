import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-8">
      <main className="flex-1">
        <h1 className="mb-4 text-3xl font-semibold">Practice Platform</h1>
        <p className="mb-6">Book an appointment or sign in to your portal.</p>
        <ul className="flex flex-col gap-3 sm:flex-row">
          <li>
            <Link href="/book" className="flex min-h-11 items-center justify-center rounded bg-blue-800 px-5 py-2 font-medium text-white hover:bg-blue-900">
              Book an appointment
            </Link>
          </li>
          <li>
            <Link href="/login" className="flex min-h-11 items-center justify-center rounded border border-neutral-600 px-5 py-2 font-medium hover:bg-neutral-500/10">
              Sign in
            </Link>
          </li>
        </ul>
      </main>
      <footer className="mt-8 border-t border-neutral-500 pt-4 text-sm">
        <p>If you are in crisis call SADAG 0800 567 567 or go to the nearest emergency room. This site is not an emergency service.</p>
      </footer>
    </div>
  );
}
