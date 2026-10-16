import { useState } from "react";
import type { DashboardData } from "./dashboard.js";
import type { NativeModel } from "./routing/classifier-config.js";

export const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 4 : 2,
  }).format(value);
export const formatTokens = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);
export type DashboardDays = 1 | 7 | 30 | 90;
export type DashboardViewProps = {
  data: DashboardData | null;
  days: DashboardDays;
  baseline: string;
  busy: boolean;
  error: string | null;
  connectionMessage: string | null;
  connectionError?: boolean;
  validating: boolean;
  nativeModels: NativeModel[];
  modelsBusy: boolean;
  modelsError: string | null;
  modelsWarnings: string[];
  savingConnection: boolean;
  onRefreshModels: () => void;
  onSaveConnection: (
    connection: Pick<NativeModel, "providerId" | "modelId">,
  ) => Promise<void>;
  onSaveJevConnection: (key: string | undefined) => Promise<void>;
  onDays: (days: DashboardDays) => void;
  onBaseline: (model: string) => void;
  onRefresh: () => void;
  onValidate: () => void;
  onThread: (threadId: string) => void;
};

function Trend({ data }: { data: DashboardData }) {
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const series = data.trend;
  const values = series.map((point) =>
    metric === "cost" ? point.totalUsd : point.inputTokens + point.outputTokens,
  );
  const baseline =
    metric === "cost" ? series.map((point) => point.baselineUsd) : [];
  const maximum = Math.max(...values, ...baseline, 0.0001);
  const x = (index: number) =>
    54 + (series.length <= 1 ? 0 : index / (series.length - 1)) * 620;
  const y = (value: number) => 166 - (value / maximum) * 134;
  const path = (numbers: number[]) =>
    numbers
      .map(
        (value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`,
      )
      .join(" ");
  const unit = metric === "cost" ? formatUsd : formatTokens;
  const label = (at: number) =>
    new Date(at).toLocaleString(
      "en-US",
      data.days === 1
        ? { hour: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", timeZone: "UTC" },
    );
  return (
    <section className="ar-section ar-trend" aria-labelledby="ar-trend-title">
      <div className="ar-section-head">
        <div>
          <h2 id="ar-trend-title">Usage over time</h2>
          <p>{data.days === 1 ? "Hourly" : "Daily"} recorded usage · UTC</p>
        </div>
        <div className="ar-segment" aria-label="Chart metric">
          {(["cost", "tokens"] satisfies Array<"cost" | "tokens">).map(
            (option) => (
              <button
                key={option}
                type="button"
                aria-pressed={metric === option}
                onClick={() => setMetric(option)}
              >
                {option === "cost" ? "Cost" : "Tokens"}
              </button>
            ),
          )}
        </div>
      </div>
      {series.length === 0 ? (
        <div className="ar-chart-empty">No usage in this period.</div>
      ) : (
        <>
          <div className="ar-chart-legend">
            <span>
              <i className="ar-mark ar-auto" />
              {metric === "cost" ? "Models + classifier" : "Recorded tokens"}
            </span>
            {metric === "cost" && (
              <span>
                <i className="ar-mark ar-baseline" />
                {data.baselineModels.find(
                  (model) => model.id === data.baselineModel,
                )?.label ?? data.baselineModel}{" "}
                estimate
              </span>
            )}
          </div>
          <svg
            className="ar-chart"
            viewBox="0 0 700 206"
            role="img"
            aria-label={`${metric === "cost" ? "Estimated cost" : "Recorded tokens"} over time. Exact values in the chart data table below.`}
          >
            {[0, 0.5, 1].map((fraction) => (
              <g key={fraction}>
                <line
                  x1="54"
                  x2="674"
                  y1={y(maximum * fraction)}
                  y2={y(maximum * fraction)}
                  className="ar-gridline"
                />
                <text x="44" y={y(maximum * fraction) + 4} textAnchor="end">
                  {unit(maximum * fraction)}
                </text>
              </g>
            ))}
            {baseline.length > 0 && (
              <path d={path(baseline)} className="ar-line ar-line-baseline" />
            )}
            <path d={path(values)} className="ar-line ar-line-auto" />
            {series.map((point, index) => (
              <circle
                key={point.at}
                cx={x(index)}
                cy={y(values[index] ?? 0)}
                r="3"
                className="ar-dot"
              >
                <title>{`${label(point.at)} UTC: ${unit(values[index] ?? 0)}`}</title>
              </circle>
            ))}
            <text x="54" y="196">
              {series[0] ? label(series[0].at) : ""}
            </text>
            <text x="674" y="196" textAnchor="end">
              {series.length > 1 && series.at(-1)
                ? label(series.at(-1)?.at ?? 0)
                : ""}
            </text>
          </svg>
          <details className="ar-chart-data">
            <summary>View chart data</summary>
            <div className="ar-table-wrap">
              <table>
                <caption className="ar-sr-only">Usage over time</caption>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Models + classifier</th>
                    <th>Baseline estimate</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((point) => (
                    <tr key={point.at}>
                      <td>{label(point.at)}</td>
                      <td>{formatUsd(point.totalUsd)}</td>
                      <td>{formatUsd(point.baselineUsd)}</td>
                      <td>
                        {formatTokens(point.inputTokens + point.outputTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function TokenBreakdown({ data }: { data: DashboardData }) {
  const tokens = [
    {
      label: "Uncached input",
      value: Math.max(
        0,
        data.totals.inputTokens -
          data.totals.cacheReadTokens -
          data.totals.cacheWriteTokens,
      ),
      className: "ar-token-input",
    },
    {
      label: "Output",
      value: data.totals.outputTokens,
      className: "ar-token-output",
    },
    {
      label: "Cache read",
      value: data.totals.cacheReadTokens,
      className: "ar-token-read",
    },
    {
      label: "Cache write",
      value: data.totals.cacheWriteTokens,
      className: "ar-token-write",
    },
  ];
  return (
    <section className="ar-section" aria-labelledby="ar-tokens-title">
      <div className="ar-section-head">
        <div>
          <h2 id="ar-tokens-title">Token breakdown</h2>
          <p>Recorded tokens, including helpers</p>
        </div>
      </div>
      <div className="ar-token-bar" aria-hidden="true">
        {tokens
          .filter((token) => token.value > 0)
          .map((token) => (
            <span
              key={token.label}
              className={token.className}
              style={{ flexGrow: token.value }}
            />
          ))}
      </div>
      <dl className="ar-data-list">
        {tokens.map((token) => (
          <div key={token.label}>
            <dt>
              <i className={`ar-mark ${token.className}`} />
              {token.label}
            </dt>
            <dd>{formatTokens(token.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="ar-footnote">
        Classifier input: {formatTokens(data.summary.jev.inputTokens)} tokens.
        Output: {formatTokens(data.summary.jev.outputTokens)} tokens, counted
        separately.
      </p>
    </section>
  );
}

const modelKey = (model: Pick<NativeModel, "providerId" | "modelId">) =>
  JSON.stringify([model.providerId, model.modelId]);

export type ClassifierMode = "jev" | "native";

export function ConnectionSetup({
  setup,
  models,
  loading,
  error,
  warnings,
  saving,
  onRefresh,
  onSave,
  onSaveJev,
  onCancel,
}: {
  setup: DashboardData["setup"];
  models: NativeModel[];
  loading: boolean;
  error: string | null;
  warnings: string[];
  saving: boolean;
  onRefresh: () => void;
  onSave: (
    connection: Pick<NativeModel, "providerId" | "modelId">,
  ) => Promise<void>;
  onSaveJev: (key: string | undefined) => Promise<void>;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<ClassifierMode>(
    setup.provider === "native" ? "native" : "jev",
  );
  const [selectedKey, setSelectedKey] = useState(
    setup.provider === "native" && setup.nativeProvider && setup.model
      ? modelKey({ providerId: setup.nativeProvider, modelId: setup.model })
      : "",
  );
  const [jevKey, setJevKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const selected = models.find((model) => modelKey(model) === selectedKey);
  const providers = [...new Set(models.map((model) => model.providerId))];
  const hasJevKey = setup.provider === "jev" && setup.configured;
  const canSubmit =
    mode === "jev"
      ? hasJevKey || jevKey.trim().length > 0
      : Boolean(selected) && !loading;
  const fail = (cause: unknown) =>
    setFormError(
      cause instanceof Error
        ? cause.message
        : "The connection did not save. Try again.",
    );
  return (
    <section
      className="ar-setup ar-connect-panel"
      aria-labelledby="ar-setup-title"
    >
      <div className="ar-connect-copy">
        <div className="ar-eyebrow">Classifier connection</div>
        <h2 id="ar-setup-title">
          {mode === "jev" ? "Connect Jev" : "Use a model already in BB"}
        </h2>
        <p>
          A classifier is the model that chooses how your task runs. It selects
          your working model and reasoning effort, then advises when helpers are
          useful.
        </p>
        {mode === "jev" ? (
          <>
            <p>
              Jev is the default classifier. It returns calibrated probabilities
              for each routing choice.
            </p>
            <div className="ar-privacy-note">
              <h3>Your Jev key</h3>
              <p>
                Jev uses a TypeSafe API key and its own API billing. Model Pilot
                saves the key as a secret plugin setting.
              </p>
              <p>Jev receives task text and routing criteria.</p>
            </div>
          </>
        ) : (
          <>
            <p>Use models already connected to BB. No additional API key.</p>
            <div className="ar-privacy-note">
              <h3>Your existing connection</h3>
              <p>
                This list comes from the same provider catalog that BB uses. The
                selected provider receives task text and routing criteria
                through your existing BB sign-in.
              </p>
              <p>
                Your subscription limits and provider usage rules still apply.
              </p>
            </div>
          </>
        )}
      </div>
      <form
        className="ar-setup-form ar-connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || saving) return;
          setFormError(null);
          if (mode === "jev") {
            const key = jevKey.trim();
            void onSaveJev(key || undefined)
              .then(() => setJevKey(""))
              .catch(fail);
            return;
          }
          if (!selected) return;
          void onSave({
            providerId: selected.providerId,
            modelId: selected.modelId,
          }).catch(fail);
        }}
      >
        <div
          className="ar-segment ar-classifier-mode"
          role="group"
          aria-label="Classifier"
        >
          {(
            [
              ["jev", "Jev"],
              ["native", "Model in BB"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={saving}
              onClick={() => {
                setMode(value);
                setFormError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "jev" ? (
          <>
            <label htmlFor="ar-classifier-key">Jev API key</label>
            <div className="ar-password-field">
              <input
                id="ar-classifier-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={jevKey}
                disabled={saving}
                placeholder={
                  hasJevKey ? "Saved. Enter a new key to replace it." : ""
                }
                aria-describedby="ar-key-help"
                onChange={(event) => {
                  setJevKey(event.currentTarget.value);
                  setFormError(null);
                }}
              />
            </div>
            <p id="ar-key-help">
              Get a key from the{" "}
              <a
                href="https://console.typesafe.ai"
                target="_blank"
                rel="noreferrer"
              >
                TypeSafe console
              </a>
              .{" "}
              {hasJevKey
                ? "Leave the field empty to keep the saved key."
                : "The connection test makes sure that the key works."}
            </p>
          </>
        ) : (
          <>
          <div className="ar-model-picker-head">
            <label htmlFor="ar-classifier-model">Classification model</label>
            <button
              type="button"
              className="ar-text-button"
              onClick={onRefresh}
              disabled={loading || saving}
            >
              {loading ? "Refreshing models…" : "Refresh models"}
            </button>
          </div>
          {loading && <p role="status">Loading models from BB…</p>}
          {error && (
            <div className="ar-form-error" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="ar-text-button"
                onClick={onRefresh}
                disabled={loading || saving}
              >
                Try again
              </button>
            </div>
          )}
          <select
            id="ar-classifier-model"
            value={selected ? selectedKey : ""}
            disabled={loading || saving || models.length === 0}
            aria-describedby="ar-model-help"
            required
            onChange={(event) => {
              setSelectedKey(event.currentTarget.value);
              setFormError(null);
            }}
          >
            <option value="" disabled>
              Select a model from BB
            </option>
            {providers.map((providerId) => (
              <optgroup
                key={providerId}
                label={
                  models.find((model) => model.providerId === providerId)
                    ?.providerLabel ?? providerId
                }
              >
                {models
                  .filter((model) => model.providerId === providerId)
                  .map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {model.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <p id="ar-model-help">
            {selected?.description ||
              "Choose a fast model for routing decisions. The connection test makes sure that your existing sign-in can use it."}
          </p>
          {!loading && !error && models.length === 0 && (
            <div className="ar-model-empty" role="status">
              <p>No models are available from BB on this host.</p>
              <p>Connect an agent provider in BB, then refresh this list.</p>
            </div>
          )}
          {warnings.map((warning) => (
            <p className="ar-caption" key={warning}>
              {warning}
            </p>
          ))}
          </>
        )}
        <p className="ar-paid-note">
          {mode === "jev"
            ? "Connect and test sends one request to Jev on your API billing."
            : "Connect and test uses your existing plan usage."}{" "}
          Your current connection stays active until the new connection passes.
        </p>
        {formError && (
          <div className="ar-form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="ar-form-actions">
          <button
            className="ar-button ar-button-primary"
            type="submit"
            disabled={saving || !canSubmit}
          >
            {saving ? "Testing connection…" : "Connect and test"}
          </button>
          {onCancel && (
            <button
              type="button"
              className="ar-button"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function PilotGuide() {
  return (
    <section className="ar-guide" aria-label="Model Pilot guide">
      <div className="ar-section ar-guide-intro">
        <div className="ar-eyebrow">How it works</div>
        <h2>Spend effort where the task needs it</h2>
        <p>
          Model Pilot chooses a working model, reasoning effort, and context
          window for your task. It can assign self-contained work to a helper so
          that searches and logs stay out of the main conversation.
        </p>
        <p>
          Smaller models can handle routine work. Stronger models can handle
          difficult decisions. The routing policy considers both task demands
          and model cost.
        </p>
      </div>
      <details className="ar-guide-topic" open>
        <summary>Start your first task</summary>
        <div>
          <p>
            Connect an agent provider in BB. Open Connection and choose a model
            from the BB catalog. The test uses your existing sign-in before BB
            saves the selection.
          </p>
          <p>
            Sign in to the agent providers that you want to use in BB. Select
            Model Pilot in the thread model picker, then describe your task
            normally.
          </p>
          <p>
            Open Usage after the task runs. Review the chosen models, classifier
            overhead, helpers, and recorded tokens.
          </p>
        </div>
      </details>
      <details className="ar-guide-topic" open>
        <summary>The first message and later messages</summary>
        <div>
          <p>
            The first message selects the main agent model, reasoning effort,
            and context window. That selection stays with the native agent
            session.
          </p>
          <p>
            Later messages keep that model and conversation. The classifier
            advises whether the main agent can work directly, needs a helper, or
            needs a plan with routed steps.
          </p>
          <p>
            Helpers receive a task brief and return their result. A helper does
            not inherit the full main conversation.
          </p>
        </div>
      </details>
      <details className="ar-guide-topic">
        <summary>Choose a classifier</summary>
        <div>
          <p>
            Choose an available model from your connected BB providers. A fast
            model can make routing decisions with less delay and plan usage.
          </p>
          <p>
            Every classifier returns a percent vote. Model Pilot picks the
            cheapest model, effort, and context window that the vote makes at
            least 65% likely to be enough. Jev's votes are calibrated. Other
            models estimate their own percents, so they are not equivalent
            confidence measurements.
          </p>
          <p>
            The classifier chooses the route. Codex and Claude Code run the
            actual task through your existing sign-ins.
          </p>
        </div>
      </details>
      <details className="ar-guide-topic">
        <summary>Understand the usage estimate</summary>
        <div>
          <p>
            Usage includes recorded work by the main agent and helpers, plus
            classifier overhead. Cache reads and cache writes appear separately
            from uncached input.
          </p>
          <p>
            The baseline estimates the cost of the same recorded tokens on
            another model. It does not measure tokens saved, task quality, or
            your subscription bill.
          </p>
          <p>
            Provider prices and retained history can limit the estimate. Read
            the coverage notes below the usage table. Missing prices make a
            complete comparison unavailable.
          </p>
        </div>
      </details>
      <details className="ar-guide-topic">
        <summary>Connections, privacy, and usage</summary>
        <div>
          <p>
            Model Pilot uses the agent connections that you manage in BB. You do
            not enter another API key on this page.
          </p>
          <p>
            The selected classifier provider receives task text and routing
            criteria. Avoid putting information in a task that you cannot share
            with that provider.
          </p>
          <p>
            Classification and agent work use your existing provider plan.
            Subscription limits, provider usage rules, and any existing billing
            still apply.
          </p>
          <p>
            Jev is the default classifier and uses its own API key and billing.
            You can choose a model already in BB instead. A new connection
            passes a connection test before it replaces the current one.
          </p>
        </div>
      </details>
      <details className="ar-guide-topic">
        <summary>Failures and compatibility</summary>
        <div>
          <p>
            If classification fails or returns an unusable answer, Model Pilot
            uses the configured fallback route. A fallback is visible in the
            routing history.
          </p>
          <p>
            If a connection test fails, the current saved connection stays
            active. Make sure that your BB sign-in, provider limits, and network
            connection work, then refresh the model list and try again.
          </p>
          <p>
            The current native-agent bridge targets BB 0.46 on macOS. Other
            platforms and BB versions need compatibility testing before public
            release.
          </p>
        </div>
      </details>
    </section>
  );
}

export function DashboardView({
  data,
  days,
  baseline,
  busy,
  error,
  connectionMessage,
  connectionError = false,
  validating,
  nativeModels,
  modelsBusy,
  modelsError,
  modelsWarnings,
  savingConnection,
  onRefreshModels,
  onSaveConnection,
  onSaveJevConnection,
  onDays,
  onBaseline,
  onRefresh,
  onValidate,
  onThread,
}: DashboardViewProps) {
  const [editingConnection, setEditingConnection] = useState(false);
  const [selectedPage, setSelectedPage] = useState<
    "usage" | "connection" | "guide" | null
  >(null);
  const setup: DashboardData["setup"] = data?.setup ?? {
    provider: "native",
    model: "",
    configured: false,
    source: "missing",
    canValidate: false,
  };
  const page = selectedPage ?? (setup.configured ? "usage" : "connection");
  return (
    <main className="ar-dashboard" aria-busy={busy}>
      <header className="ar-header">
        <div>
          <div className="ar-eyebrow">
            Automatic model selection and delegation
          </div>
          <h1>Model Pilot</h1>
          <p>
            Match your agent model and reasoning effort to the task, then use
            helpers when they are useful.
          </p>
        </div>
        <button
          className="ar-button"
          type="button"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <nav className="ar-page-nav" aria-label="Model Pilot pages">
        {(["usage", "connection", "guide"] as const).map((name) => (
          <button
            type="button"
            key={name}
            disabled={savingConnection || validating}
            aria-current={page === name ? "page" : undefined}
            onClick={() => {
              setSelectedPage(name);
              setEditingConnection(false);
            }}
          >
            {name === "usage"
              ? "Usage"
              : name === "connection"
                ? "Connection"
                : "Guide"}
          </button>
        ))}
      </nav>
      {page === "guide" && <PilotGuide />}
      {page === "usage" && (
        <div className="ar-toolbar">
          <div className="ar-segment" aria-label="Date range">
            {([1, 7, 30, 90] satisfies DashboardDays[]).map((period) => (
              <button
                key={period}
                type="button"
                aria-pressed={days === period}
                onClick={() => onDays(period)}
              >
                {period === 1 ? "24 hours" : `${period} days`}
              </button>
            ))}
          </div>
          <label className="ar-baseline-picker">
            Compare with{" "}
            <select
              value={baseline}
              onChange={(event) => onBaseline(event.currentTarget.value)}
            >
              {(
                data?.baselineModels ?? [
                  { id: "claude-opus-5-5", label: "Opus 5.5" },
                ]
              ).map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && (
        <div className="ar-notice" role="alert">
          <p>{error}</p>
          <button type="button" className="ar-button" onClick={onRefresh}>
            Try again
          </button>
        </div>
      )}
      {page === "usage" && !data && !error && (
        <p role="status" className="ar-loading">
          Loading routing history…
        </p>
      )}
      {
        <>
          {page === "connection" && (
            <>
              {!setup.configured || editingConnection ? (
                <ConnectionSetup
                  key={editingConnection ? "editing" : "initial"}
                  setup={setup}
                  models={nativeModels}
                  loading={modelsBusy}
                  error={modelsError}
                  warnings={modelsWarnings}
                  onRefresh={onRefreshModels}
                  saving={savingConnection}
                  onSave={async (connection) => {
                    await onSaveConnection(connection);
                    setEditingConnection(false);
                    setSelectedPage("connection");
                  }}
                  onSaveJev={async (key) => {
                    await onSaveJevConnection(key);
                    setEditingConnection(false);
                    setSelectedPage("connection");
                  }}
                  onCancel={
                    setup.configured
                      ? () => setEditingConnection(false)
                      : undefined
                  }
                />
              ) : (
                <section
                  className="ar-section ar-connected"
                  aria-labelledby="ar-connected-title"
                >
                  <div className="ar-eyebrow">Connection</div>
                  <h2 id="ar-connected-title">Classifier configured</h2>
                  <p>
                    {setup.provider === "native"
                      ? "The saved model uses your existing BB sign-in. Test the connection to make sure that it can answer now."
                      : setup.provider === "jev"
                        ? "Jev classifies your tasks with its saved API key. Test the connection to make sure that it can answer now."
                        : "An earlier API connection is active. Choose Jev or a BB model to replace it."}
                  </p>
                  <dl className="ar-data-list">
                    <div>
                      <dt>Provider</dt>
                      <dd>
                        {setup.provider === "native"
                          ? (nativeModels.find(
                              (model) =>
                                model.providerId === setup.nativeProvider,
                            )?.providerLabel ?? setup.nativeProvider)
                          : setup.provider === "jev"
                            ? "Jev (TypeSafe)"
                            : setup.provider}
                      </dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>
                        {setup.provider === "native"
                          ? (nativeModels.find(
                              (model) =>
                                model.providerId === setup.nativeProvider &&
                                model.modelId === setup.model,
                            )?.label ?? setup.model)
                          : setup.model}
                      </dd>
                    </div>
                    <div>
                      <dt>Connection</dt>
                      <dd>
                        {setup.provider === "native"
                          ? "Existing BB sign-in"
                          : setup.provider !== "jev"
                            ? "Earlier API connection"
                            : setup.source === "setting"
                              ? "API key in plugin settings"
                              : "Saved key on this machine"}
                      </dd>
                    </div>
                  </dl>
                  <p className="ar-paid-note">
                    {setup.provider === "native"
                      ? "The connection test uses your existing plan usage. Subscription limits still apply."
                      : setup.provider === "jev"
                        ? "The connection test sends one request to Jev on your API billing."
                        : "Testing this earlier connection uses its existing API billing."}
                  </p>
                  <div className="ar-form-actions">
                    <button
                      type="button"
                      className="ar-button ar-button-primary"
                      disabled={validating}
                      onClick={onValidate}
                    >
                      {validating ? "Testing connection…" : "Test connection"}
                    </button>
                    <button
                      type="button"
                      className="ar-button"
                      disabled={validating}
                      onClick={() => setEditingConnection(true)}
                    >
                      Change connection
                    </button>
                  </div>
                </section>
              )}
              <section className="ar-section ar-next-step">
                <h2>Use Model Pilot in a thread</h2>
                <p>
                  Keep your Codex and Claude Code sign-ins in BB. Select Model
                  Pilot in the model picker and send your task.
                </p>
                <button
                  className="ar-text-button"
                  type="button"
                  onClick={() => setSelectedPage("guide")}
                >
                  Read the guide
                </button>
              </section>
            </>
          )}
          {connectionMessage && !editingConnection && (
            <p
              role={connectionError ? "alert" : "status"}
              className="ar-connection-message"
            >
              {connectionMessage}
            </p>
          )}
          {page === "usage" && data && (
            <>
              <div className="ar-stat-grid">
                <section className="ar-stat">
                  <h2>Model Pilot cost estimate</h2>
                  <div className="ar-stat-value">
                    {formatUsd(data.summary.totalUsd)}
                  </div>
                  <p>
                    Models {formatUsd(data.summary.modelUsd)}{" "}
                    <span aria-hidden="true">·</span> Classifier{" "}
                    {formatUsd(data.summary.jev.usd)}
                  </p>
                </section>
                <section className="ar-stat ar-stat-featured">
                  <h2>
                    {data.summary.unpriced.length
                      ? "Incomplete pricing"
                      : data.comparison.differenceUsd >= 0
                        ? "Estimated cost reduction"
                        : "Estimated extra cost"}
                  </h2>
                  <div className="ar-stat-value">
                    {data.summary.unpriced.length
                      ? "Unavailable"
                      : formatUsd(Math.abs(data.comparison.differenceUsd))}
                    <span>
                      {data.summary.unpriced.length ||
                      data.comparison.percent === null
                        ? ""
                        : `${Math.abs(data.comparison.percent).toFixed(1)}%`}
                    </span>
                  </div>
                  <p>
                    {data.summary.unpriced.length
                      ? "Some models have no recorded rate"
                      : "Same tokens at the selected baseline rate"}
                  </p>
                </section>
                <section className="ar-stat">
                  <h2>Recorded tokens</h2>
                  <div className="ar-stat-value">
                    {formatTokens(data.totals.tokens)}
                  </div>
                  <p>
                    {formatTokens(data.totals.threads)}{" "}
                    {data.totals.threads === 1 ? "thread" : "threads"}{" "}
                    <span aria-hidden="true">·</span>{" "}
                    {formatTokens(data.totals.helpers)}{" "}
                    {data.totals.helpers === 1 ? "helper" : "helpers"}
                  </p>
                </section>
                <section className="ar-stat">
                  <h2>Routing decisions</h2>
                  <div className="ar-stat-value">
                    {formatTokens(
                      data.summary.routes.main + data.summary.routes.helper,
                    )}
                  </div>
                  <p>
                    {formatTokens(data.summary.routes.fallback)} fallbacks{" "}
                    <span aria-hidden="true">·</span>{" "}
                    {formatTokens(data.summary.jev.failed)} classifier failures
                  </p>
                </section>
              </div>
              <div className="ar-comparison-note">
                <span className="ar-note-label">Estimate, explained</span>
                <p>
                  The baseline prices the same recorded tokens on one model. It
                  does not measure tokens saved, task quality, or subscription
                  charges.
                </p>
                <p>{data.summary.pricing.source}</p>
              </div>
              <div className="ar-chart-grid">
                <Trend data={data} />
                <TokenBreakdown data={data} />
              </div>
              <section className="ar-section" aria-labelledby="ar-models-title">
                <div className="ar-section-head">
                  <div>
                    <h2 id="ar-models-title">Model mix</h2>
                    <p>Share of estimated model cost</p>
                  </div>
                  <span className="ar-caption">
                    {formatTokens(data.summary.usageTurns)} turns
                  </span>
                </div>
                {data.models.length === 0 ? (
                  <p className="ar-empty">
                    No model usage recorded yet. Start a thread with the Auto
                    provider to see it here.
                  </p>
                ) : (
                  <div className="ar-model-grid">
                    {data.models.map((model) => (
                      <div className="ar-model" key={model.model}>
                        <div className="ar-model-label">
                          <span>{model.label}</span>
                          <span>{formatUsd(model.usd)}</span>
                        </div>
                        <div
                          className="ar-model-track"
                          role="meter"
                          aria-label={`${model.label} share of estimated model cost`}
                          aria-valuenow={model.share * 100}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div style={{ width: `${model.share * 100}%` }} />
                        </div>
                        <div className="ar-model-meta">
                          <span>
                            {formatTokens(model.turns)}{" "}
                            {model.turns === 1 ? "turn" : "turns"}
                          </span>
                          <span>{(model.share * 100).toFixed(1)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section
                className="ar-section"
                aria-labelledby="ar-threads-title"
              >
                <div className="ar-section-head">
                  <div>
                    <h2 id="ar-threads-title">Recent threads</h2>
                    <p>Open a thread to see its conversation</p>
                  </div>
                </div>
                {data.threads.length === 0 ? (
                  <p className="ar-empty">No routed threads in this period.</p>
                ) : (
                  <div className="ar-table-wrap">
                    <table>
                      <caption className="ar-sr-only">
                        Recent routed threads
                      </caption>
                      <thead>
                        <tr>
                          <th>Thread</th>
                          <th>Model</th>
                          <th>Tokens</th>
                          <th>Models + classifier</th>
                          <th>Baseline estimate</th>
                          <th>Classifier calls</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.threads.map((thread) => (
                          <tr key={thread.threadId}>
                            <td>
                              <button
                                type="button"
                                className="ar-thread-link"
                                onClick={() => onThread(thread.threadId)}
                              >
                                {thread.title || thread.threadId}
                              </button>
                              <div className="ar-thread-meta">
                                {thread.helper ? "Helper · " : ""}
                                {new Date(
                                  thread.updatedAt,
                                ).toLocaleDateString()}
                                {thread.failures > 0
                                  ? ` · ${thread.failures} routing failures`
                                  : ""}
                              </div>
                            </td>
                            <td>
                              {data.baselineModels.find(
                                (model) => model.id === thread.model,
                              )?.label ??
                                thread.model ??
                                "No usage"}
                            </td>
                            <td>{formatTokens(thread.tokens)}</td>
                            <td>{formatUsd(thread.totalUsd)}</td>
                            <td>{formatUsd(thread.baselineUsd)}</td>
                            <td>{formatTokens(thread.jevCalls)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <footer className="ar-footer">
                <div>
                  <p>{data.coverage.scope}</p>
                  {data.coverage.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  <p>Updated {new Date(data.generatedAt).toLocaleString()}.</p>
                </div>
                <button
                  type="button"
                  className="ar-text-button"
                  onClick={() => setSelectedPage("connection")}
                >
                  Manage classifier connection
                </button>
              </footer>
            </>
          )}
        </>
      }
    </main>
  );
}
