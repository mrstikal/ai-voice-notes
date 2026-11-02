"use client";

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface NoteTab {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

interface NoteTabsProps {
  readonly tabs: readonly NoteTab[];
  readonly initialTabId?: string;
}

export function NoteTabs({ tabs, initialTabId }: NoteTabsProps) {
  const baseId = useId();
  const firstTabId = initialTabId ?? tabs[0]?.id ?? "";
  const [activeId, setActiveId] = useState(firstTabId);
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set([firstTabId]),
  );
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  function activate(id: string) {
    setActiveId(id);
    setVisited((current) => {
      if (current.has(id)) {
        return current;
      }

      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    const nextTab = tabs[nextIndex];

    if (!nextTab) {
      return;
    }

    event.preventDefault();
    activate(nextTab.id);
    tabRefs.current.get(nextTab.id)?.focus();
  }

  return (
    <div className="mt-8">
      <div
        aria-label="Záložky detailu poznámky"
        className="flex flex-wrap gap-2 border-b border-stone-300 pb-2"
        role="tablist"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;

          return (
            <button
              aria-controls={`${baseId}-panel-${tab.id}`}
              aria-selected={selected}
              className={
                selected
                  ? "shrink-0 rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
                  : "shrink-0 rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              }
              id={`${baseId}-tab-${tab.id}`}
              key={tab.id}
              onClick={() => activate(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                if (element) {
                  tabRefs.current.set(tab.id, element);
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        const mounted = visited.has(tab.id);

        return (
          <div
            aria-labelledby={`${baseId}-tab-${tab.id}`}
            hidden={!selected}
            id={`${baseId}-panel-${tab.id}`}
            key={tab.id}
            role="tabpanel"
            tabIndex={0}
          >
            {mounted ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
