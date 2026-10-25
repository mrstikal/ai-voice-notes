import Link from "next/link";

export default function NoteNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
        Poznámka nenalezena
      </h1>
      <p className="mt-3 leading-7 text-stone-600">
        Poznámka neexistuje, byla smazána nebo odkaz není platný.
      </p>
      <p className="mt-6">
        <Link
          className="text-sm font-medium text-emerald-800 underline underline-offset-4 hover:text-emerald-950"
          href="/notes"
        >
          Zpět na poznámky
        </Link>
      </p>
    </div>
  );
}
