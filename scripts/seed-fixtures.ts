export type SeedFixtureSizeBand = "short" | "medium" | "long";

export interface SeedFixture {
  readonly code: string;
  readonly key: string;
  readonly title: string;
  readonly sizeBand: SeedFixtureSizeBand;
  readonly contentMd: string;
}

export const SEED_KEY_PREFIX = "demo-v1:";

export const SEED_FIXTURES = [
  {
    code: "D01",
    key: "demo-v1:D01",
    title: "Plán migrace PostgreSQL",
    sizeBand: "medium",
    contentMd: `# Plán migrace PostgreSQL

Migraci databáze na novější verzi naplánujeme na sobotu dopoledne, kdy je provoz aplikace nejnižší. Nejprve ověříme zálohu a připravíme si seznam rozšíření, která používáme.

## Postup

1. Zastavit zapisující služby a ověřit, že žádný klient nedrží otevřenou transakci.
2. Vytvořit novou databázi vedle stávající a obnovit do ní zálohu.
3. Spustit migrační skript a porovnat počty řádků v klíčových tabulkách.
4. Přepnout aplikaci na novou databázi a sledovat chybovost.

## Kontrola

- [ ] Ověřit volné místo na disku a limity připojení.
- [ ] Zkontrolovat \`pg_upgrade\` a dostupnost rozšíření pgvector.
- [ ] Otestovat přihlášení aplikace a načtení seznamu poznámek.
- [ ] Připravit krátký návod pro návrat k původní databázi.

> Pokud kontrola odhalí chybějící index nebo nesoulad v datech, migraci zastavíme a vrátíme se k záloze. O změně informujeme tým v pondělí.`,
  },
  {
    code: "D02",
    key: "demo-v1:D02",
    title: "Zápis z pondělního stand-upu",
    sizeBand: "medium",
    contentMd: `# Pondělní stand-up

Sešli jsme se v devět hodin, aby každý stručně popsal, co dokončil minulý týden a co ho čeká.

## Dokončeno

- Nahrávání poznámek běží spolehlivě i při pomalém připojení.
- Seznam poznámek se stránkováním jsme otestovali na českých datech.
- Opravili jsme chybu, která po obnovení z koše zobrazila zastaralý název.

## Plán

- [ ] Dodělat kontrolu oprávnění u mazání poznámek.
- [ ] Připravit testovací scénář pro souběžné úpravy.
- [ ] Zkontrolovat přístupnost formulářů na klávesnici.

## Rizika

Největší riziko je dokončení exportu do konce týdne. Pokud se objeví problém s knihovnou pro DOCX, přesuneme export na příští sprint a prioritou zůstane stabilní editor. Stand-up trval dvacet minut.`,
  },
  {
    code: "D03",
    key: "demo-v1:D03",
    title: "Nákupní seznam na víkend",
    sizeBand: "short",
    contentMd: `## Nákup na víkend

- chléb, máslo a sýr
- jablka, banány a pomeranče
- mléko, jogurt a vejce
- brambory, mrkev a cibule
- káva a čaj

V sobotu doplním čerstvé pečivo a v neděli uvařím polévku z kořenové zeleniny.`,
  },
  {
    code: "D04",
    key: "demo-v1:D04",
    title: "Nápady pro hlasové poznámky",
    sizeBand: "medium",
    contentMd: `# Nápady pro hlasové poznámky

Chceme, aby diktování působilo přirozeně a uživatel nemusel přemýšlet nad technickými detaily.

## Možnosti

- Krátká poznámka nahraná jedním stisknutím a ihned přepsaná do textu.
- Příkaz „pošli to do koše“ s potvrzením, aby se omylem nesmazala důležitá poznámka.
- Rozlišení mezi novou poznámkou a doplněním existující poznámky podle kontextu.
- Večerní shrnutí dne, které nabídne tři nejdůležitější body.

## Co ověřit

- [ ] Jak přesně funguje přepis českých jmen a odborných termínů?
- [ ] Umožní poskytovatel přerušit dlouhý přepis bez ztráty textu?
- [ ] Bude mikrofon viditelně aktivní po celou dobu nahrávání?

> Hlas je jen vstup. Uložená poznámka musí zůstat obyčejný Markdown, který lze kdykoli upravit ručně.

První verzi omezíme na krátké poznámky do jedné minuty. Delší záznamy necháme na později, až budeme mít spolehlivé časové značky a jasné potvrzení ceny.`,
  },
  {
    code: "D05",
    key: "demo-v1:D05",
    title: "Recept na bramborovou polévku",
    sizeBand: "short",
    contentMd: `## Bramborová polévka

Potřebuji brambory, cibuli, mrkev, celer, kmín, majoránku a zeleninový vývar.

1. Na másle orestuji cibuli a kořenovou zeleninu.
2. Přidám brambory, kmín a vývar.
3. Vařím dvacet minut, poté polévku rozmixuji.
4. Dochutím solí, pepřem a majoránkou.`,
  },
  {
    code: "D06",
    key: "demo-v1:D06",
    title: "Čtenářský deník",
    sizeBand: "medium",
    contentMd: `# Čtenářský deník

## Tento týden

Dočetl jsem *Kroniku ptáčka na klíček*. Nejvíc mě zasáhla část o dospívání a o tom, jak se rodina učí mluvit o věcech, které bolí. Napsal jsem si několik citátů, ale nechci je používat bez kontextu.

- *Mistr a Markétka* – začátek je náročný, ale dialogy jsou skvělé.
- *Zahrada* – krátké texty, ideální na večer před spaním.
- *Příběhy z Českého ráje* – chci je číst přímo na místě.

## Poznámky

- [ ] Vypsat jména postav, která se pletou.
- [ ] Zjistit, které povídky jsou v antologii nové.
- [ ] Půjčit si v knihovně knihu o české krajině.

Příští týden si dám cíl přečíst alespoň sto stran a zapsat si jednu myšlenku denně. Čtení o samotě mi pomáhá soustředit se, ale občas je užitečné o knize mluvit s někým dalším.`,
  },
  {
    code: "D07",
    key: "demo-v1:D07",
    title: "Kontrolní seznam zálohování",
    sizeBand: "medium",
    contentMd: `# Kontrolní seznam zálohování

Před každým větším zásahem do databáze projdu tento seznam. Cílem není udělat všechno najednou, ale mít jistotu, že se můžeme vrátit.

## Před zásahem

- [ ] Ověřit, že poslední záloha doběhla bez chyby.
- [ ] Zkontrolovat volné místo na disku.
- [ ] Zapsat aktuální verzi aplikace a databáze.
- [ ] Upozornit kolegy, že bude krátká odstávka.

## Po zásahu

- [ ] Spustit zdravotní kontrolu a přihlásit se do aplikace.
- [ ] Ověřit počet poznámek a poslední revize.
- [ ] Zkusit obnovit jednu poznámku z koše.
- [ ] Uložit záznam o průběhu a případných odchylkách.

Zálohy ukládám mimo stroj s aplikací a jednou za měsíc zkouším obnovu na čisté databázi. Bez tohoto cvičení je záloha jen souborem, o kterém doufáme, že funguje.`,
  },
  {
    code: "D08",
    key: "demo-v1:D08",
    title: "Výlet do Českého ráje",
    sizeBand: "medium",
    contentMd: `# Výlet do Českého ráje

Na sobotu plánujeme celodenní výlet. Chceme vyrazit brzy, aby byl čas na prohlídku skal i na pozdní oběd.

## Trasa

- Sraz v sedm hodin u vlakového nádraží.
- Vlak do Turnova a potom pěšky směrem na Hruboskalsko.
- Krátká zastávka u vyhlídky a oběd v hospodě.
- Návrat podvečerním vlakem, nejpozději v osmnáct hodin.

## S sebou

- [ ] Dostatek vody a lehká svačina.
- [ ] Pláštěnka a náhradní ponožky.
- [ ] Nabíječka a stažená mapa.
- [ ] Peníze na vstup a oběd.

Pokud bude ráno pršet, výlet přesuneme na neděli. Skály jsou po dešti kluzké a nechci riskovat úraz. Pro jistotu si večer znovu zkontroluji počasí a napíšu ostatním, zda platí původní čas.`,
  },
  {
    code: "D09",
    key: "demo-v1:D09",
    title: "Výsledky testů API",
    sizeBand: "medium",
    contentMd: `# Výsledky testů API

Dnes jsem prošel testy poznámkového API. Většina scénářů je stabilní, ale našly se dvě místa, která potřebují pozornost.

## Prošlo

- Vytvoření poznámky s českým názvem i obsahem.
- Stránkování aktivních poznámek a řazení podle času.
- Soft delete a obnovení z koše včetně verze.
- Odmítnutí neplatného UUID a zastaralé verze.

## Selhalo

- Požadavek s \`content_plain\` navíc skončil chybou 500 místo očekávané 400.
- Dlouhý obsah se správně odmítne, ale chybová zpráva neuvádí limit v bajtech.

## Další kroky

- [ ] Přidat test přesně na hranici jednoho megabajtu.
- [ ] Sjednotit chybové odpovědi pro neplatný tvar požadavku.
- [ ] Zopakovat test souběžné úpravy s kratším časovým oknem.

Výsledky jsem uložil do testovací databáze a připravil krátký souhrn pro tým. Opravy nasadíme až po další kontrole, aby se změna neprolnula s připravovaným exportem.`,
  },
  {
    code: "D10",
    key: "demo-v1:D10",
    title: "Osobní cíle na podzim",
    sizeBand: "medium",
    contentMd: `# Osobní cíle na podzim

Podzim chci pojmout klidněji než léto. Nechci stíhat všechno, ale dokončit několik věcí pořádně.

## Zdraví

- Chodit každý den alespoň dvacet minut pěšky.
- Dvakrát týdně cvičit krátkou sestavu na záda.
- Spát pravidelně a odkládat telefon dřív než obvykle.

## Práce

- [ ] Dokončit rozdělaný projekt bez odkládání na poslední chvíli.
- [ ] Zapsat si po každém jednání tři konkrétní body.
- [ ] Jednou za týden zkontrolovat, co se skutečně posunulo.

## Vztahy

Chci častěji volat rodičům a domluvit alespoň jeden výlet s přáteli. Také si nechám v kalendáři volný večer, kdy nic neplánuji a jen čtu nebo vařím. Cíle nejsou závazek, ale směr, kterým se chci ubírat.`,
  },
  {
    code: "D11",
    key: "demo-v1:D11",
    title: "Poznámky z konference",
    sizeBand: "long",
    contentMd: `# Poznámky z konference

Na konferenci o lokálních aplikacích a soukromí jsem si zapsal několik postupů, které chceme vyzkoušet v našem projektu. Akce byla menší, ale přednášky byly konkrétní a bez zbytečného marketingu.

## Úvodní přednáška

První blok se věnoval tomu, jak navrhovat aplikace, které fungují bez cloudu. Přednášející zdůraznil, že lokální aplikace neznamená méně práce, jen jiné rozdělení odpovědnosti. Data zůstávají u uživatele, ale musíme vyřešit zálohy, migrace a jasné chybové stavy.

Zaujalo mě doporučení, aby každá operace měla viditelný výsledek a možnost návratu. Ukládání nesmí tiše selhat a uživatel musí vědět, kdy je obsah skutečně uložený.

> Dobrá lokální aplikace se chová jako nástroj, ne jako černá skříňka.

## Editor a Markdown

Druhý blok ukazoval práci s Markdownem v bohatém editoru. Hlavní myšlenka byla jednoduchá: Markdown je kanonický formát a vizuální editor je jen jedna z možností, jak ho upravovat. Pokud převod ztratí význam, musí se zobrazit zdrojový text místo tichého zjednodušení.

- Podporovat jen uzavřenou množinu značek a tu dobře otestovat.
- Neslibovat dokonalý převod všech možných formátů.
- Umožnit ruční opravu přímo ve zdrojovém režimu.
- Ukládat revize tak, aby se dalo vrátit k předchozímu stavu.

## Testování

Třetí blok byl o testech. Líbilo se mi rozlišení mezi testy chování a testy uživatelského rozhraní. Databázové testy mají běžet proti izolované testovací databázi a nesmí se nikdy omylem připojit k vývojovým datům.

- [ ] Přidat test, který ověří přesnou hranici velikosti požadavku.
- [ ] Zkontrolovat, že testovací server používá pouze databázi s koncovkou \`_test\`.
- [ ] Domluvit pravidelný běh testů před každým větším krokem.
- [ ] Zapsat, které testy vyžadují databázi a které ne.

## Poznámky k výkonu

U lokální aplikace se výkon neměří jen počtem požadavků za sekundu. Důležité je, jak rychle se načte seznam, jak dlouho trvá uložení a zda aplikace zůstane použitelná, když databáze na chvíli vypadne. Chybový stav má být srozumitelný a musí nabídnout další krok.

## Co si odnáším

- Menší počet dobře promyšlených funkcí je lepší než velký seznam polovičních nápadů.
- Každá automatická změna musí mít jasnou evidenci a možnost vrátit se zpět.
- Uživatelské rozhraní má vysvětlovat limity dřív, než uživatel narazí na chybu.
- Testy mají být rychlé, opakovatelné a bez závislosti na placených službách.

Konference mi potvrdila, že směr našeho projektu je rozumný. Příští týden projdu své poznámky s týmem a vybereme dva konkrétní návrhy, které vyzkoušíme v praxi.`,
  },
  {
    code: "D12",
    key: "demo-v1:D12",
    title: "Krátká připomínka",
    sizeBand: "short",
    contentMd: `## Připomínka

**Zavolat zítra v devět hodin** ohledně prodloužení licence. Vzít si k ruce smlouvu a seznam otázek. Po hovoru zapsat domluvené termíny a poslat krátké potvrzení e-mailem.`,
  },
  {
    code: "D13",
    key: "demo-v1:D13",
    title: "Rozpočet domácnosti",
    sizeBand: "medium",
    contentMd: `# Rozpočet domácnosti

Tento měsíc chci mít přehled o pravidelných výdajích a našetřit na opravu kola.

## Pevné výdaje

- Nájem a energie: 18 500 Kč.
- Internet a telefon: 1 200 Kč.
- Pojištění: 900 Kč.
- Pravidelné platby a předplatné: 650 Kč.

## Variabilní výdaje

- Potraviny: plán 7 000 Kč, zatím 4 200 Kč.
- Doprava: 1 500 Kč.
- Kultura a volný čas: 1 200 Kč.
- Drogerie a léky: 800 Kč.

## Cíl

- [ ] Uložit alespoň 3 000 Kč na opravu kola.
- [ ] Zrušit předplatné, které jsem za poslední měsíc nepoužil.
- [ ] Zapsat všechny platby do společné tabulky.

Rezervu nechávám na neočekávané opravy. Pokud se výdaje vylepší, přebytek půjde na kolo, ne na jednorázové nákupy. Na konci měsíce si porovnám plán se skutečností a upravím další rozpočet.`,
  },
  {
    code: "D14",
    key: "demo-v1:D14",
    title: "Nápady na školení týmu",
    sizeBand: "medium",
    contentMd: `# Nápady na školení týmu

Chceme připravit krátké praktické školení, které lidem pomůže s každodenní prací, ne jen zaplní kalendář.

## Témata

- Bezpečná práce s tajnými klíči a konfigurací.
- Jak číst chybové zprávy a najít první užitečnou stopu.
- Základy Markdownu a strukturování delších poznámek.
- Jak připravit malý testovací scénář bez databáze.

## Formát

- [ ] Dvě hodiny v malé skupině, maximálně osm lidí.
- [ ] Krátké vysvětlení a potom společná praktická úloha.
- [ ] Prostor na otázky a krátké shrnutí na konci.
- [ ] Materiály předem, aby se dalo připravit.

## Co potřebujeme

Místnost s projektorem a možností připojení k testovacímu prostředí. Každý účastník by měl mít vlastní počítač a přístup k ukázkovému repozitáři. Nechci, aby školení skončilo jen prezentací; důležité je, aby si lidé vyzkoušeli postup sami.

Termín navrhnu na příští středu a potom pošlu krátký dotazník, co bylo nejužitečnější.`,
  },
  {
    code: "D15",
    key: "demo-v1:D15",
    title: "Plán běžeckého tréninku",
    sizeBand: "medium",
    contentMd: `# Plán běžeckého tréninku

Chtěl bych zlepšit vytrvalost bez zbytečného přetěžování. Tréninky si rozdělím do tří týdnů a nechám jeden den na odpočinek.

## Týden 1

- [ ] Pondělí: volno a krátká chůze.
- [ ] Úterý: 5 km lehkým tempem.
- [ ] Čtvrtek: 6 km střídavě rychleji a pomaleji.
- [ ] Sobota: 8 km v klidném tempu.

## Týden 2

- Pondělí: volno.
- Úterý: 6 km lehkým tempem.
- Čtvrtek: 7 km s krátkými zrychleními.
- Sobota: 10 km, pokud se budu cítit dobře.

## Týden 3

- Pondělí: volno.
- Úterý: 5 km lehce.
- Čtvrtek: 6 km s kopcem.
- Sobota: 12 km a potom delší protažení.

Po každém běhu si zapíšu vzdálenost, pocit a případnou bolest. Pokud se objeví ostrá bolest, trénink zkrátím. Cílem není nejrychlejší čas, ale pravidelnost a zdravé návyky.`,
  },
  {
    code: "D16",
    key: "demo-v1:D16",
    title: "Zápis ze schůzky s klientem",
    sizeBand: "long",
    contentMd: `# Zápis ze schůzky s klientem

Sešli jsme se ve firmě klienta, abychom prošli první verzi aplikace a domluvili další postup. Schůzka trvala necelé dvě hodiny a zúčastnili se jí tři lidé z jejich týmu.

## Co klient potřebuje

Klient spravuje poznámky z terénních návštěv a část práce dělá na tabletu bez spolehlivého připojení. Potřebuje rychlé vytvoření poznámky, přehledné hledání a jistotu, že se data neztratí.

- Vytvoření poznámky musí být možné i bez připojení k internetu.
- Názvy a štítky mají být viditelné v přehledu.
- Smazané poznámky musí zůstat v koši alespoň třicet dní.
- Export do dokumentu má být dostupný z detailu poznámky.

## Průběh ukázky

Ukázali jsme vytvoření poznámky, stránkování a obnovení z koše. Klient ocenil, že seznam zůstává přehledný i při delších názvech. U detailu chtěl vědět, zda půjde upravit obsah i bez vizuálního editoru. Vysvětlili jsme mu, že zdrojový Markdown bude vždy dostupný.

> Klient zdůraznil, že nejdůležitější je důvěra v uložená data, ne množství funkcí.

## Otevřené otázky

- [ ] Jak dlouho chce uchovávat historii změn?
- [ ] Kdo bude mít přístup k exportovaným souborům?
- [ ] Má se koš automaticky čistit, nebo o tom má rozhodnout uživatel?
- [ ] Jak má aplikace postupovat, když databáze není dostupná?

## Dohodnuté kroky

- [ ] Připravit ukázku exportu do Markdownu.
- [ ] Ověřit chování při přerušení ukládání.
- [ ] Zapsat připomínky k formulaci tlačítek.
- [ ] Naplánovat další schůzku na začátek příštího měsíce.

## Dojmy a doporučení

Klient byl věcný a měl dobře připravené otázky. Nechce složité nastavení ani mnoho voleb. Doporučuji držet rozhraní jednoduché a vysvětlovat limity přímo v místě, kde se objeví. Pokud budeme přidávat další funkce, musí zůstat jasné, která data se ukládají lokálně a která opouštějí počítač.

Další krok je poslat krátké shrnutí do dvou dnů a označit body, které potřebují rozhodnutí. Do té doby nebudeme měnit datový model ani přidávat nové závislosti.`,
  },
  {
    code: "D17",
    key: "demo-v1:D17",
    title: "Knihy k přečtení",
    sizeBand: "short",
    contentMd: `## Knihy k přečtení

- *Kronika ptáčka na klíček* – silný příběh, pomalu číst.
- *Mistr a Markétka* – vrátit se k poznámkám z minule.
- *Zahrada* – krátké texty na večer.
- *Příběhy z Českého ráje* – na výlet.

Až dočtu rozepsanou knihu, začnu tou nejtenčí.`,
  },
  {
    code: "D18",
    key: "demo-v1:D18",
    title: "Řešení výpadku databáze",
    sizeBand: "long",
    contentMd: `# Řešení výpadku databáze

V pondělí ráno se aplikace přestala načítat. Prohlížeč zobrazoval chybu připojení a zdravotní kontrola vracela chybu 503. Začal jsem postupovat podle havarijního seznamu a zapisovat každý krok.

## Průběh

Nejprve jsem ověřil, že webový server běží a že se k němu dostanu přes loopback adresu. Potom jsem zkontroloval kontejner s databází. Kontejner byl spuštěný, ale služba PostgreSQL ještě dokončovala inicializaci. Po restartu PostgreSQL nefungovalo připojení, protože služba čekala na inicializaci databáze. Pomohla kontrola healthchecku.

## Co jsem zkontroloval

- [ ] Stav kontejneru a čas posledního restartu.
- [ ] Logy databáze a případné chyby při startu.
- [ ] Dostupnost portu a přihlašovací údaje.
- [ ] Zdravotní kontrolu aplikace po obnovení.

## Příčina

Restart hostitelského počítače ukončil kontejner dřív, než databáze dokončila kontrolu konzistence. Automatický restart sice kontejner spustil, ale aplikace se připojila příliš brzy a dostala odmítnutí. Healthcheck měl delší interval, než bylo potřeba, takže aplikace hlásila chybu i poté, co databáze už byla v pořádku.

## Náprava

- Zkrátit interval healthchecku a přidat startovní prodlevu.
- Ověřovat připojení pomocí jednoduchého dotazu \`SELECT 1\`.
- Zobrazit v aplikaci srozumitelnou českou chybu s dalším krokem.
- Zapsat incident do provozního deníku.

## Prevence

Přidám kontrolu, která po startu počká na zdravý stav databáze a teprve potom spustí aplikaci. Zároveň zjednoduším diagnostiku tak, aby se dalo z logu poznat, zda je problém v kontejneru, v připojení, nebo v samotné aplikaci. Po opravě jsem znovu prošel vytvoření poznámky, seznam i obnovení z koše.

> Výpadek trval přibližně dvanáct minut. Data zůstala v pořádku, protože zápis probíhá v transakcích a záloha byla aktuální.

## Poučení

- [ ] Nespouštět aplikaci dřív, než je databáze připravená.
- [ ] Kontrolovat healthcheck při každém nasazení.
- [ ] Zapsat přesný čas a průběh incidentu.
- [ ] Otestovat obnovu zálohy na izolované databázi.

Příště budu postupovat stejně: nejdřív zjistit rozsah, potom obnovit službu a teprve nakonec hledat dlouhodobé řešení. Rychlá oprava nesmí znamenat ztrátu dat nebo obcházení kontrol.`,
  },
  {
    code: "D19",
    key: "demo-v1:D19",
    title: "Projektový týdenní souhrn",
    sizeBand: "long",
    contentMd: `# Projektový týdenní souhrn

Týden byl rozdělený mezi dokončení databázové vrstvy a přípravu uživatelského rozhraní. Tým pracoval v menším složení, protože dva kolegové byli na školení.

## Hotovo

- Připravili jsme migraci s tabulkami pro poznámky, revize a štítky.
- Otestovali jsme vytvoření, úpravu, smazání a obnovení poznámky.
- Rozdělili jsme testy na izolované databázové a rychlé jednotkové.
- Přidali jsme české chybové zprávy pro neplatné vstupy.

## Rozpracováno

- [ ] Stránkování seznamu poznámek a koše.
- [ ] Formulář pro vytvoření poznámky s validací názvu.
- [ ] Zobrazení data a času v českém formátu.
- [ ] Kontrola přístupnosti tlačítek a formulářů.

## Rizika

Největší riziko je časování mezi databázovou vrstvou a rozhraním. Pokud se změní tvar odpovědi, může se rozbít zobrazení seznamu. Proto chceme mít malý kontraktní test, který ověří základní pole a chybové stavy.

Další riziko je příliš mnoho souběžných změn v jedné větvi. Sloučení bude jednodušší, když se dohodneme na menších celcích a budeme je průběžně kontrolovat.

## Plán na příští týden

- [ ] Dokončit seznam a koš včetně prázdných stavů.
- [ ] Ověřit obnovení poznámky a navazující revizi.
- [ ] Připravit scénář pro dvě souběžné úpravy.
- [ ] Zkontrolovat build a všechny testy před předáním.

## Poznámky k práci

Ukázalo se, že je užitečné psát si krátké poznámky přímo při práci a potom je sloučit do jednoho souhrnu. Zabrání to zapomenutí drobných rozhodnutí. Zároveň je potřeba hlídat, aby se z pomocných poznámek nestal nepořádek; na konci dne je proto krátce roztřídím.

Tým se shodl, že příští týden nebudeme přidávat nové funkce nad rámec plánu. Prioritou je stabilní základ, srozumitelné chyby a testy, které lze spustit bez placených služeb.`,
  },
  {
    code: "D20",
    key: "demo-v1:D20",
    title: "Dvě podobné věty v dokumentu",
    sizeBand: "medium",
    contentMd: `# Dvě podobné věty v dokumentu

Tento dokument slouží k ověření, že aplikace rozliší dvě stejně vypadající věty a nebude je zaměňovat při úpravách.

V úterý dokončíme testy API.

Mezitím připravíme seznam otevřených otázek a rozešleme ho všem členům týmu. Chceme mít jistotu, že každý ví, která část dokumentace se mění a kdo ji schvaluje.

V úterý dokončíme testy API.

Potom porovnáme výsledky s předchozím během a zapíšeme rozdíly. Pokud se objeví nová chyba, založíme samostatný úkol a nebudeme ji řešit v tomto dokumentu.

## Kontrola

- [ ] Ověřit, že se obě věty zobrazují správně.
- [ ] Zkontrolovat, že úprava jedné věty nezmění druhou.
- [ ] Popsat výsledek do poznámky k testu.

Text záměrně neobsahuje další stejné věty, aby byl test jednoznačný.`,
  },
] as const satisfies readonly SeedFixture[];
