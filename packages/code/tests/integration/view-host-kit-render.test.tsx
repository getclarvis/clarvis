import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import {
  Dash,
  DetailLines,
  ErrorBanner,
  FieldRow,
  LoadingHint,
  SectionHeader,
  SelectableList,
  SelectableRow,
  SettingRow,
  StatusRow,
  ToggleRow,
} from "../../src/views/config/view-host.tsx";
import { tokens } from "../../src/theme/tokens.ts";
import { EntityRow } from "../../src/ui/primitives/entity-row.tsx";

async function lines(ui: () => unknown, width = 80, height = 24): Promise<string[]> {
  const t = await openRender(ui as never, { width, height });
  await t.renderOnce();
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out.split("\n");
}

test("SelectableList anchors trailing rows directly under a content-sized list", async () => {
  const rows = await lines(() => (
    <box width={80} height={24} flexDirection="column">
      <SelectableList<string>
        each={() => ["alpha", "beta", "gamma"]}
        sel={() => 1}
        idPrefix="kit-"
        row={(item, i) => (
          <SelectableRow selected={i() === 1}>
            <span style={{ fg: tokens.fg }}>{item}</span>
          </SelectableRow>
        )}
        trailing={<text fg={tokens.muted}>SUMMARY UNDER LIST</text>}
      />
    </box>
  ));
  const first = rows.findIndex((r) => r.includes("alpha"));
  const summary = rows.findIndex((r) => r.includes("SUMMARY UNDER LIST"));
  expect(first).toBe(0);
  expect(summary).toBe(3);
});

test("SelectableList empty/loading/error states replace the list, not each other", async () => {
  const empty = await lines(() => (
    <SelectableList<string>
      each={() => []}
      sel={() => 0}
      idPrefix="kit-"
      row={() => <text>row</text>}
      empty={() => ({ text: "nothing configured yet" })}
    />
  ));
  expect(empty.some((r) => r.includes("nothing configured yet"))).toBe(true);

  const loading = await lines(() => (
    <SelectableList<string>
      each={() => []}
      sel={() => 0}
      idPrefix="kit-"
      row={() => <text>row</text>}
      loading={() => true}
      empty={() => ({ text: "nothing configured yet" })}
    />
  ));
  expect(loading.some((r) => r.includes("loading"))).toBe(true);
  expect(loading.some((r) => r.includes("nothing configured yet"))).toBe(false);

  const failed = await lines(() => (
    <SelectableList<string>
      each={() => []}
      sel={() => 0}
      idPrefix="kit-"
      row={() => <text>row</text>}
      loading={() => false}
      error={() => "backend list failed: boom"}
      empty={() => ({ text: "nothing configured yet" })}
    />
  ));
  expect(failed.some((r) => r.includes("backend list failed: boom"))).toBe(true);
  expect(failed.some((r) => r.includes("nothing configured yet"))).toBe(false);
});

test("a persistent error banner rides above a still-populated list", async () => {
  const rows = await lines(() => (
    <SelectableList<string>
      each={() => ["alpha"]}
      sel={() => 0}
      idPrefix="kit-"
      row={(item) => <text fg={tokens.fg}>{item}</text>}
      error={() => "refresh failed"}
    />
  ));
  const banner = rows.findIndex((r) => r.includes("refresh failed"));
  const item = rows.findIndex((r) => r.includes("alpha"));
  expect(banner).toBeGreaterThanOrEqual(0);
  expect(item).toBeGreaterThan(banner);
});

test("ToggleRow renders booleans as a switch state", async () => {
  const on = await lines(() => <ToggleRow label="enabled" value={true} selected />);
  expect(on.some((r) => r.includes("enabled") && r.includes("on"))).toBe(true);
  const off = await lines(() => <ToggleRow label="enabled" value={false} />);
  expect(off.some((r) => r.includes("enabled") && r.includes("off"))).toBe(true);
});

test("FieldRow kind='enum' appends the caret affordance", async () => {
  const rows = await lines(() => <FieldRow label="kind" value="anthropic" kind="enum" />);
  expect(rows.some((r) => r.includes("anthropic  ▾"))).toBe(true);
});

test("StatusRow and indented DetailLines share FieldRow's value column", async () => {
  const rows = await lines(() => (
    <box width={80} height={24} flexDirection="column">
      <FieldRow label="enabled" value="VALUE-A" />
      <StatusRow label="effective" text="VALUE-B" />
      <DetailLines rows={[{ text: "VALUE-C continuation", fg: tokens.muted }]} indent />
    </box>
  ));
  const colOf = (needle: string) => rows.find((r) => r.includes(needle))!.indexOf(needle);
  expect(colOf("VALUE-B")).toBe(colOf("VALUE-A"));
  expect(colOf("VALUE-C")).toBe(colOf("VALUE-A"));
});

test("EntityRow keeps identity, state, badges, action, metadata and read-only reason explicit", async () => {
  const rows = await lines(() => (
    <box width={80} height={24} flexDirection="column">
      <EntityRow
        selected
        action="open details"
        entity={{
          id: "A3",
          title: "Review the renderer",
          state: "needs-approval",
          description: "Checks the responsive frame",
          metadata: ["sonnet", "2 iterations"],
          current: true,
          default: true,
          readOnlyReason: "provided by the running workflow",
        }}
      />
      <EntityRow entity={{ title: "Unconfigured agent" }} />
    </box>
  ));
  const out = rows.join("\n");
  expect(out).toContain("A3");
  expect(out).toContain("Review the renderer");
  expect(out).toContain("Needs approval");
  expect(out).toContain("current, default");
  expect(out).toContain("open details");
  expect(out).toContain("Checks the responsive frame · sonnet · 2 iterations");
  expect(out).toContain("Read-only — provided by the running workflow");
  expect(out).toContain("Unconfigured agent");
});

test("SettingRow exposes editable and read-only mutation contracts", async () => {
  const rows = await lines(() => (
    <box width={100} height={24} flexDirection="column">
      <SettingRow
        selected
        expanded
        setting={{
          label: "Model",
          configured: "inherit",
          effective: "anthropic/sonnet",
          source: "global",
          applies: "next run",
          mutation: "staged",
        }}
      />
      <SettingRow
        expanded
        setting={{
          label: "Runtime",
          configured: "bun",
          effective: "node",
          source: "provider",
          applies: "now",
          mutation: "read-only",
          readOnlyReason: "reported by the host",
        }}
      />
    </box>
  ));
  const out = rows.join("\n");
  expect(out).toContain("change Model");
  expect(out).toContain("Configured here: inherit");
  expect(out).toContain("Effective:       anthropic/sonnet");
  expect(out).toContain("Runtime");
  expect(out).toContain("configured bun · provider · now");
  expect(out).toContain("Read-only — reported by the host");
});

test("DetailLines without indent renders the plugin/marketplace detail rows verbatim", async () => {
  const rows = await lines(() => (
    <DetailLines
      rows={[
        { text: "source   github.com/x", fg: tokens.muted },
        { text: "already installed", fg: tokens.add },
      ]}
    />
  ));
  expect(rows[0]).toContain("source   github.com/x");
  expect(rows[1]).toContain("already installed");
});

test("SectionHeader, Dash, LoadingHint and ErrorBanner render their idioms", async () => {
  const rows = await lines(() => (
    <box width={80} height={24} flexDirection="column">
      <SectionHeader label="identity" />
      <Dash />
      <LoadingHint text="fetching marketplaces" />
      <ErrorBanner text="trust file unreadable" detail={["fix or delete it"]} />
    </box>
  ));
  expect(rows.some((r) => r.includes("── identity"))).toBe(true);
  expect(rows.some((r) => r.trim() === "—")).toBe(true);
  expect(rows.some((r) => r.includes("fetching marketplaces…"))).toBe(true);
  expect(rows.some((r) => r.includes("✗ trust file unreadable"))).toBe(true);
  expect(rows.some((r) => r.includes("fix or delete it"))).toBe(true);
});

test("SelectableList caps a long list and follows the selection through its wrapper ids", async () => {
  const items = Array.from({ length: 40 }, (_, i) => `item-${i}`);
  const [sel, setSel] = createSignal(0);
  const t = await openRender(
    (() => (
      <box width={80} height={24} flexDirection="column">
        <SelectableList<string>
          each={() => items}
          sel={sel}
          idPrefix="cap-"
          maxRows={5}
          row={(item, i) => (
            <SelectableRow selected={i() === sel()}>
              <span style={{ fg: tokens.fg }}>{item}</span>
            </SelectableRow>
          )}
          trailing={<text fg={tokens.muted}>SUMMARY UNDER LIST</text>}
        />
      </box>
    )) as never,
    { width: 80, height: 24 },
  );
  await t.renderOnce();
  await t.renderOnce();
  let rows = t.captureCharFrame().split("\n");
  expect(rows.findIndex((r) => r.includes("SUMMARY UNDER LIST"))).toBe(5);
  setSel(9);
  await t.renderOnce();
  await t.renderOnce();
  rows = t.captureCharFrame().split("\n");
  expect(rows.some((r) => r.includes("item-9"))).toBe(true);
  expect(rows.some((r) => r.includes("item-0 "))).toBe(false);
  t.renderer.destroy();
});
