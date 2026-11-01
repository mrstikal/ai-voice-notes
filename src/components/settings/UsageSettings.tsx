export function UsageSettings() {
  return (
    <section
      aria-labelledby="soukromi"
      className="rounded-2xl border border-stone-200 bg-white p-6"
    >
      <h2 id="soukromi" className="text-xl font-semibold text-stone-950">
        Poskytovatelé, soukromí a cena
      </h2>
      <div className="mt-4 space-y-3 leading-7 text-stone-700">
        <p>
          Poznámky jsou uložené pouze v místní databázi. Teprve při výslovném
          spuštění placené AI operace odešle aplikace zvolený text nebo zvuk
          uvedenému poskytovateli. Bez API klíčů zůstávají ručně psané
          poznámky plně použitelné.
        </p>
        <p>
          Místní rozpočet je pouze odhad pro rozhodnutí, zda operaci zahájit.
          Není to limit na straně poskytovatele. Skutečná cena může být jiná a
          silnější limit nastavte přímo u poskytovatele.
        </p>
        <p>
          Neznámá nebo nejistá cena se záměrně nevykazuje jako nula. Zůstává
          jako <strong>Neznámá cena</strong>, dokud ji nelze spolehlivě
          vyúčtovat.
        </p>
      </div>
    </section>
  );
}
