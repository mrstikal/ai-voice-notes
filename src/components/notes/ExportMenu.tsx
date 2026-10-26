interface ExportMenuProps {
  readonly noteId: string;
}

export function ExportMenu({ noteId }: ExportMenuProps) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
        Export
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-stone-200 bg-white p-1 shadow-lg">
        <a
          className="block rounded-md px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          href={`/api/notes/${noteId}/export?format=md`}
        >
          Markdown (.md)
        </a>
        <a
          className="block rounded-md px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          href={`/api/notes/${noteId}/export?format=docx`}
        >
          DOCX (.docx)
        </a>
      </div>
    </details>
  );
}
