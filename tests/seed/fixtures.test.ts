import type { ListItem } from "mdast";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";

import {
  SEED_FIXTURES,
  SEED_KEY_PREFIX,
  type SeedFixture,
  type SeedFixtureSizeBand,
} from "../../scripts/seed-fixtures";
import {
  parseNoteMarkdown,
  type ParsedNoteMarkdown,
} from "../../src/lib/notes/markdown";

const EXPECTED_FIXTURES = [
  ["D01", "Plán migrace PostgreSQL", "medium"],
  ["D02", "Zápis z pondělního stand-upu", "medium"],
  ["D03", "Nákupní seznam na víkend", "short"],
  ["D04", "Nápady pro hlasové poznámky", "medium"],
  ["D05", "Recept na bramborovou polévku", "short"],
  ["D06", "Čtenářský deník", "medium"],
  ["D07", "Kontrolní seznam zálohování", "medium"],
  ["D08", "Výlet do Českého ráje", "medium"],
  ["D09", "Výsledky testů API", "medium"],
  ["D10", "Osobní cíle na podzim", "medium"],
  ["D11", "Poznámky z konference", "long"],
  ["D12", "Krátká připomínka", "short"],
  ["D13", "Rozpočet domácnosti", "medium"],
  ["D14", "Nápady na školení týmu", "medium"],
  ["D15", "Plán běžeckého tréninku", "medium"],
  ["D16", "Zápis ze schůzky s klientem", "long"],
  ["D17", "Knihy k přečtení", "short"],
  ["D18", "Řešení výpadku databáze", "long"],
  ["D19", "Projektový týdenní souhrn", "long"],
  ["D20", "Dvě podobné věty v dokumentu", "medium"],
] as const;

const SIZE_BANDS: Record<SeedFixtureSizeBand, readonly [number, number]> = {
  short: [100, 350],
  medium: [450, 1_100],
  long: [1_400, 2_600],
};

const D18_SENTENCE =
  "Po restartu PostgreSQL nefungovalo připojení, protože služba čekala na inicializaci databáze. Pomohla kontrola healthchecku.";
const D20_SENTENCE = "V úterý dokončíme testy API.";

function fixtureByCode(code: string): SeedFixture {
  const fixture = SEED_FIXTURES.find((candidate) => candidate.code === code);

  if (!fixture) {
    throw new Error(`Chybí fixture ${code}.`);
  }

  return fixture;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function featureFlags(parsed: ParsedNoteMarkdown): {
  heading: boolean;
  task: boolean;
  ordinaryList: boolean;
} {
  let heading = false;
  let task = false;
  let ordinaryList = false;

  visit(parsed.ast, (node) => {
    if (node.type === "heading") {
      heading = true;
    }

    if (node.type === "listItem") {
      const item = node as ListItem;
      if (item.checked === true || item.checked === false) {
        task = true;
      } else {
        ordinaryList = true;
      }
    }
  });

  return { heading, task, ordinaryList };
}

describe("seed fixtures", () => {
  it("contains exactly the 20 required codes, titles, and size bands", () => {
    expect(
      SEED_FIXTURES.map((fixture) => [
        fixture.code,
        fixture.title,
        fixture.sizeBand,
      ]),
    ).toEqual(EXPECTED_FIXTURES);

    const keys = SEED_FIXTURES.map((fixture) => fixture.key);
    const titles = SEED_FIXTURES.map((fixture) => fixture.title);

    expect(new Set(keys).size).toBe(20);
    expect(new Set(titles).size).toBe(20);
    expect(SEED_KEY_PREFIX).toBe("demo-v1:");
    expect(keys).toEqual(
      EXPECTED_FIXTURES.map(([code]) => `demo-v1:${code}`),
    );

    for (const fixture of SEED_FIXTURES) {
      expect(fixture.key).toBe(`${SEED_KEY_PREFIX}${fixture.code}`);
    }
  });

  it("uses the supported canonical Markdown subset and Czech diacritics", () => {
    for (const fixture of SEED_FIXTURES) {
      const parsed = parseNoteMarkdown(fixture.contentMd);

      expect(parsed.sourceOnly, fixture.code).toBe(false);
      expect(parsed.sourceOnlyReasons, fixture.code).toEqual([]);
      expect(parsed.plainText.length, fixture.code).toBeGreaterThan(0);
      expect(fixture.contentMd, fixture.code).toMatch(/[áčďéěíňóřšťúůýž]/i);
    }
  });

  it("meets the four short, twelve medium, and four long grapheme bands", () => {
    const counts: Record<SeedFixtureSizeBand, number> = {
      short: 0,
      medium: 0,
      long: 0,
    };

    for (const fixture of SEED_FIXTURES) {
      const parsed = parseNoteMarkdown(fixture.contentMd);
      const [minimum, maximum] = SIZE_BANDS[fixture.sizeBand];

      expect(parsed.graphemeCount, fixture.code).toBeGreaterThanOrEqual(minimum);
      expect(parsed.graphemeCount, fixture.code).toBeLessThanOrEqual(maximum);
      expect(parsed.graphemeCount, fixture.code).toBeLessThan(20_000);

      counts[fixture.sizeBand] += 1;
    }

    expect(counts).toEqual({ short: 4, medium: 12, long: 4 });
  });

  it("contains enough headings, task lists, and ordinary lists", () => {
    const flags = SEED_FIXTURES.map((fixture) =>
      featureFlags(parseNoteMarkdown(fixture.contentMd)),
    );

    expect(flags.filter((flag) => flag.heading)).toHaveLength(20);
    expect(flags.filter((flag) => flag.heading).length).toBeGreaterThanOrEqual(8);
    expect(flags.filter((flag) => flag.task).length).toBeGreaterThanOrEqual(6);
    expect(
      flags.filter((flag) => flag.ordinaryList).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("contains the literal D18 incident sentence exactly once", () => {
    const fixture = fixtureByCode("D18");

    expect(fixture.sizeBand).toBe("long");
    expect(fixture.contentMd).toContain(D18_SENTENCE);
    expect(countOccurrences(fixture.contentMd, D18_SENTENCE)).toBe(1);

    const total = SEED_FIXTURES.reduce(
      (count, candidate) =>
        count + countOccurrences(candidate.contentMd, D18_SENTENCE),
      0,
    );
    expect(total).toBe(1);
  });

  it("contains the duplicate D20 sentence exactly twice in separate paragraphs", () => {
    const fixture = fixtureByCode("D20");

    expect(fixture.sizeBand).toBe("medium");
    expect(countOccurrences(fixture.contentMd, D20_SENTENCE)).toBe(2);

    const paragraphs = fixture.contentMd
      .split(/\n\s*\n/)
      .filter((block) => block.includes(D20_SENTENCE));

    expect(paragraphs).toHaveLength(2);
    expect(
      paragraphs.every(
        (paragraph) => countOccurrences(paragraph, D20_SENTENCE) === 1,
      ),
    ).toBe(true);

    const total = SEED_FIXTURES.reduce(
      (count, candidate) =>
        count + countOccurrences(candidate.contentMd, D20_SENTENCE),
      0,
    );
    expect(total).toBe(2);
  });
});
