import type { Accessor, JSX } from "solid-js";
import { Index, Show, createMemo } from "solid-js";
import { tokens } from "../theme/tokens.ts";
import { BrandWordmark } from "./brand.tsx";
import type { HeaderPlan } from "./header-projection.ts";

/** Props for {@link HeaderRows}. */
export interface HeaderRowsProps {
  plan: Accessor<HeaderPlan>;
}

/**
 * Renders the app header's workspace, active identity, run configuration, host state and version.
 */
export function HeaderRows(props: HeaderRowsProps): JSX.Element {
  const rows = createMemo(() => {
    const plan = props.plan();
    const available = Math.max(1, plan.width - 2);
    const fields = [
      plan.workspace,
      ...(plan.identity ? [plan.identity] : []),
      ...plan.status,
      ...(plan.exception ? [plan.exception] : []),
      ...(plan.urgent ? [plan.urgent] : []),
      plan.version,
    ];
    const result: Array<Array<{ text: string; color: string; version: boolean }>> = [[]];
    let used = 9;
    for (const field of fields) {
      const raw = field.text.replace(/^\s*·\s*/, "").trim();
      const gap = field.key === "version" ? " " : "  ·  ";
      const needed = Bun.stringWidth(gap + raw);
      if (used > 0 && used + needed > available) {
        result.push([]);
        used = 0;
      }
      const text = (used > 0 ? gap : "") + raw;
      result[result.length - 1]!.push({
        text,
        color: field.color,
        version: field.key === "version",
      });
      used += Bun.stringWidth(text);
    }
    return result;
  });
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={tokens.bg}
      zIndex={1}
    >
      <Index each={rows()}>
        {(row, index) => (
          <box flexDirection="row" flexShrink={0}>
            <Show when={index === 0}>
              <BrandWordmark />
            </Show>
            <Index each={row()}>
              {(field) => (
                <>
                  <Show when={field().version}>
                    <box flexGrow={1} />
                  </Show>
                  <text
                    fg={field().color}
                    flexShrink={0}
                    maxWidth={Math.max(1, props.plan().width - 2)}
                    wrapMode="char"
                  >
                    {field().text}
                  </text>
                </>
              )}
            </Index>
          </box>
        )}
      </Index>
    </box>
  );
}
