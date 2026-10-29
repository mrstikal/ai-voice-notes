export interface CzechSearchEvaluationQuery {
  readonly id: string;
  readonly query: string;
  readonly expectedSeedKeys: readonly string[];
}

export const CZECH_SEARCH_EVALUATION_QUERIES = [
  {
    id: "Q01",
    query: "migraci databáze",
    expectedSeedKeys: ["demo-v1:D01"],
  },
  {
    id: "Q02",
    query: "dvě podobné věty",
    expectedSeedKeys: ["demo-v1:D20"],
  },
  {
    id: "Q03",
    query: "stand-up",
    expectedSeedKeys: ["demo-v1:D02"],
  },
  {
    id: "Q04",
    query: "nákupní seznam na víkend",
    expectedSeedKeys: ["demo-v1:D03"],
  },
  {
    id: "Q05",
    query: "běžecký trénink",
    expectedSeedKeys: ["demo-v1:D15"],
  },
  {
    id: "Q06",
    query: "hlasové diktování",
    expectedSeedKeys: ["demo-v1:D04"],
  },
  {
    id: "Q07",
    query: "bramborovou polévku",
    expectedSeedKeys: ["demo-v1:D05"],
  },
  {
    id: "Q08",
    query: "čtenářský deník",
    expectedSeedKeys: ["demo-v1:D06"],
  },
  {
    id: "Q09",
    query: "knihy k přečtení",
    expectedSeedKeys: ["demo-v1:D17"],
  },
  {
    id: "Q10",
    query: "kontrolní seznam zálohování",
    expectedSeedKeys: ["demo-v1:D07"],
  },
  {
    id: "Q11",
    query: "výpadek databáze",
    expectedSeedKeys: ["demo-v1:D18"],
  },
  {
    id: "Q12",
    query: "výlet do Českého ráje",
    expectedSeedKeys: ["demo-v1:D08"],
  },
  {
    id: "Q13",
    query: "projektový týdenní souhrn",
    expectedSeedKeys: ["demo-v1:D19"],
  },
  {
    id: "Q14",
    query: "výsledky testů API",
    expectedSeedKeys: ["demo-v1:D09"],
  },
  {
    id: "Q15",
    query: "osobní cíle na podzim",
    expectedSeedKeys: ["demo-v1:D10"],
  },
  {
    id: "Q16",
    query: "poznámky z konference",
    expectedSeedKeys: ["demo-v1:D11"],
  },
  {
    id: "Q17",
    query: "zavolat ohledně licence",
    expectedSeedKeys: ["demo-v1:D12"],
  },
  {
    id: "Q18",
    query: "rozpočet domácnosti",
    expectedSeedKeys: ["demo-v1:D13"],
  },
  {
    id: "Q19",
    query: "školení týmu",
    expectedSeedKeys: ["demo-v1:D14"],
  },
  {
    id: "Q20",
    query: "schůzka s klientem",
    expectedSeedKeys: ["demo-v1:D16"],
  },
] as const satisfies readonly CzechSearchEvaluationQuery[];

export const CZECH_SEARCH_EVALUATION_QUERY_COUNT =
  CZECH_SEARCH_EVALUATION_QUERIES.length;
