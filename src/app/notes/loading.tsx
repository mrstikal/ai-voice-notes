export default function NotesLoading() {
  return (
    <div
      aria-live="polite"
      className="mx-auto max-w-4xl px-6 py-12"
      role="status"
    >
      <p className="text-stone-600">Načítám poznámky…</p>
    </div>
  );
}
