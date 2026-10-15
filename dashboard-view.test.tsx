import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardView,
  ConnectionSetup,
  PilotGuide,
  formatUsd,
  type DashboardViewProps,
} from "./dashboard-view.js";
import { summarizeRouting } from "./report.js";
import type { DashboardData } from "./dashboard.js";

function fixture(): DashboardData {
  const summary = summarizeRouting([]);
  summary.totalUsd = 0.21;
  summary.modelUsd = 0.2;
  summary.jev.usd = 0.01;
  summary.usageTurns = 2;
  summary.jev.inputTokens = 12;
  return {
    generatedAt: Date.UTC(2026, 9, 15),
    startAt: Date.UTC(2026, 9, 14),
    endAt: Date.UTC(2026, 9, 15),
    days: 1,
    hostId: "local",
    baselineModel: "claude-opus-5-5",
    baselineModels: [{ id: "claude-opus-5-5", label: "Opus 5.5" }],
    summary,
    totals: {
      inputTokens: 5000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
      tokens: 5100,
      sessions: 1,
      threads: 1,
      helpers: 0,
    },
    models: [
      {
        model: "gpt-6-luna",
        label: "GPT-6 Luna",
        turns: 2,
        inputTokens: 5000,
        outputTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 1000,
        usd: 0.2,
        share: 1,
      },
    ],
    trend: [
      {
        at: Date.UTC(2026, 9, 15),
        label: "2026-10-15T00:00:00.000Z",
        totalUsd: 0.21,
        baselineUsd: 0.8,
        inputTokens: 5000,
        outputTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 1000,
        jevUsd: 0.01,
      },
    ],
    threads: [
      {
        threadId: "thread-1",
        title: "<script>secret</script>",
        helper: false,
        updatedAt: Date.UTC(2026, 9, 15),
        model: "gpt-6-luna",
        tokens: 5100,
        totalUsd: 0.21,
        baselineUsd: 0.8,
        jevCalls: 2,
        failures: 0,
      },
    ],
    setup: {
      configured: true,
      source: "setting",
      canValidate: true,
      provider: "jev",
      model: "jev-latest",
    },
    coverage: {
      scope: "Selected host.",
      retainedPerSession: 100,
      warnings: ["Retained usage only."],
    },
    comparison: {
      estimated: true,
      baselineUsd: 0.8,
      autoUsd: 0.21,
      differenceUsd: 0.59,
      percent: 73.75,
      label: "Same-token estimate",
    },
  };
}
const props = (data: DashboardData | null): DashboardViewProps => ({
  data,
  days: 1,
  baseline: "claude-opus-5-5",
  busy: false,
  error: null,
  connectionMessage: null,
  validating: false,
  nativeModels: [],
  modelsBusy: false,
  modelsError: null,
  modelsWarnings: [],
  savingConnection: false,
  onRefreshModels() {},
  onDays() {},
  onBaseline() {},
  onRefresh() {},
  onValidate() {},
  onThread() {},
  async onSaveConnection() {},
});

test("recorded usage separates cache from uncached input and describes estimate limits", () => {
  const html = renderToStaticMarkup(<DashboardView {...props(fixture())} />);
  assert.match(html, /Uncached input/);
  assert.match(html, /5,100/);
  assert.doesNotMatch(html, /8,100/);
  assert.match(html, /does not measure tokens saved/);
  assert.match(html, /\$0.59/);
  assert.match(html, /73.8%/);
  assert.match(html, /View chart data/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /&lt;script&gt;secret&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("new users select from the BB catalog without entering an API key", () => {
  const data = fixture();
  data.setup = {
    configured: false,
    source: "missing",
    canValidate: false,
    provider: "native",
    model: "",
  };
  const html = renderToStaticMarkup(
    <DashboardView {...props(data)} nativeModels={catalog} />,
  );
  assert.doesNotMatch(html, /type="password"|ar-classifier-key|Get a key/);
  assert.match(html, /No additional API key/);
  assert.match(html, /optgroup label="Connected Codex"/);
  assert.match(html, /Catalog model one/);
  assert.match(html, /aria-current="page">Connection/);
  assert.match(html, /existing plan usage/);
  assert.match(html, /current connection stays active/);
});

test("configured users open usage without key entry", () => {
  const data = fixture();
  data.setup = {
    configured: true,
    source: "setting",
    canValidate: true,
    provider: "jev",
    model: "jev-latest",
  };
  const html = renderToStaticMarkup(<DashboardView {...props(data)} />);
  assert.doesNotMatch(html, /type="password"/);
  assert.match(html, /Manage classifier connection/);
  assert.match(html, /aria-current="page">Usage/);
});

test("loading and failed requests expose status and retry", () => {
  const loading = renderToStaticMarkup(<DashboardView {...props(null)} busy />);
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-busy="true"/);
  const failed = renderToStaticMarkup(
    <DashboardView {...props(null)} error="Host offline" />,
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Try again/);
});

test("small Jev charges remain visible", () => {
  assert.equal(formatUsd(0.0002), "$0.0002");
  assert.equal(formatUsd(0), "$0.00");
});

test("incomplete pricing does not advertise partial savings", () => {
  const data = fixture();
  data.summary.unpriced.push("unpriced-model");
  const html = renderToStaticMarkup(<DashboardView {...props(data)} />);
  assert.match(html, /Incomplete pricing/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /73.8%/);
  assert.doesNotMatch(html, /\$0.59/);
});

const catalog = [
  {
    providerId: "codex",
    modelId: "model-one",
    label: "Catalog model one",
    providerLabel: "Connected Codex",
    description: "A model from BB.",
    reasoningEffort: "low",
  },
  {
    providerId: "claude-code",
    modelId: "model-two",
    label: "Catalog model two",
    providerLabel: "Connected Claude",
    description: "Another BB model.",
    reasoningEffort: "low",
  },
] satisfies DashboardViewProps["nativeModels"];
const connectionProps = () => ({
  setup: fixture().setup,
  models: catalog,
  loading: false,
  error: null,
  warnings: [],
  saving: false,
  onRefresh() {},
  async onSave() {},
});

test("connection catalog uses provider groups and no hardcoded model names", () => {
  const html = renderToStaticMarkup(
    <ConnectionSetup {...connectionProps()} onCancel={() => {}} />,
  );
  assert.match(html, /optgroup label="Connected Codex"/);
  assert.match(html, /optgroup label="Connected Claude"/);
  assert.match(html, /Catalog model two/);
  assert.match(html, /Refresh models/);
  assert.match(html, /Cancel/);
  assert.doesNotMatch(html, /gpt-5.6|Haiku 4.5|jev-latest|type="password"/);
});

test("models load independently and failed catalog requests offer retry", () => {
  const loading = renderToStaticMarkup(
    <ConnectionSetup {...connectionProps()} loading />,
  );
  assert.match(loading, /Loading models from BB/);
  assert.match(loading, /role="status"/);
  assert.match(loading, /disabled=""/);
  const failed = renderToStaticMarkup(
    <ConnectionSetup {...connectionProps()} error="Host offline" models={[]} />,
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Host offline/);
  assert.match(failed, /Try again/);
});

test("empty catalog explains how to connect a provider", () => {
  const html = renderToStaticMarkup(
    <ConnectionSetup
      {...connectionProps()}
      models={[]}
      warnings={["Provider unavailable"]}
    />,
  );
  assert.match(html, /No models are available from BB/);
  assert.match(html, /Connect an agent provider in BB/);
  assert.match(html, /Provider unavailable/);
  assert.match(html, /disabled=""/);
});

test("testing a candidate disables changes and keeps the current selection", () => {
  const setup: DashboardData["setup"] = {
    ...fixture().setup,
    provider: "native",
    nativeProvider: "codex",
    model: "model-one",
  };
  const html = renderToStaticMarkup(
    <ConnectionSetup {...connectionProps()} setup={setup} saving />,
  );
  assert.match(html, /selected=""/);
  assert.match(html, /Testing connection/);
  assert.match(html, /disabled=""/);
  assert.match(
    html,
    /current connection stays active until the new connection passes/,
  );
});

test("guide explains session persistence, classification differences, privacy, and estimate limits", () => {
  const html = renderToStaticMarkup(<PilotGuide />);
  assert.match(html, /Later messages keep that model and conversation/);
  assert.match(html, /not equivalent confidence measurements/);
  assert.match(html, /does not measure tokens saved/);
  assert.match(html, /selected classifier provider receives task text/);
  assert.match(html, /BB 0.46 on macOS/);
  assert.match(html, /current saved connection stays active/);
});

test("connection failures are announced as errors", () => {
  const html = renderToStaticMarkup(
    <DashboardView
      {...props(fixture())}
      connectionMessage="Provider did not answer."
      connectionError
    />,
  );
  assert.match(
    html,
    /role="alert" class="ar-connection-message">Provider did not answer/,
  );
});

test("connection catalog remains usable when usage history fails", () => {
  const html = renderToStaticMarkup(
    <DashboardView
      {...props(null)}
      error="History unavailable"
      nativeModels={catalog}
    />,
  );
  assert.match(html, /History unavailable/);
  assert.match(html, /Catalog model one/);
  assert.match(html, /Select a model from BB/);
  assert.match(html, /Connect and test/);
});
