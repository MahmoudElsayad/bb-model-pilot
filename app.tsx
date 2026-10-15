import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { DashboardData } from "./dashboard.js";
import type { NativeModel } from "./routing/classifier-config.js";
import { DashboardView, type DashboardDays } from "./dashboard-view.js";
import "./dashboard.css";

function RoutingDashboard({ threadId }: { threadId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [days, setDays] = useState<DashboardDays>(30);
  const [baseline, setBaseline] = useState("claude-opus-5-5");
  const [data, setData] = useState<DashboardData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(
    null,
  );
  const [connectionError, setConnectionError] = useState(false);
  const [validating, setValidating] = useState(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [nativeModels, setNativeModels] = useState<NativeModel[]>([]);
  const [modelsBusy, setModelsBusy] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsWarnings, setModelsWarnings] = useState<string[]>([]);
  const modelRequestId = useRef(0);
  const hostId = data?.hostId;
  const loadModels = useCallback(async () => {
    const request = ++modelRequestId.current;
    setModelsBusy(true);
    setModelsError(null);
    try {
      const result = await rpc.call("localModels", hostId ? { hostId } : {});
      if (modelRequestId.current === request) {
        setNativeModels(result.models);
        setModelsWarnings(result.warnings);
      }
    } catch (cause) {
      if (modelRequestId.current === request) {
        setNativeModels([]);
        setModelsWarnings([]);
        setModelsError(
          cause instanceof Error ? cause.message : "BB models are unavailable.",
        );
      }
    } finally {
      if (modelRequestId.current === request) setModelsBusy(false);
    }
  }, [rpc, hostId]);
  useEffect(() => {
    void loadModels();
    return () => {
      modelRequestId.current++;
    };
  }, [loadModels]);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("dashboard", {
        days,
        baselineModel: baseline,
        ...(threadId ? { threadId } : {}),
      });
      if (requestId.current === request) setData(result);
    } catch (cause) {
      if (requestId.current === request)
        setError(
          cause instanceof Error
            ? cause.message
            : "Routing history is unavailable.",
        );
    } finally {
      if (requestId.current === request) setBusy(false);
    }
  }, [rpc, days, baseline, threadId]);
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  const validate = async () => {
    setValidating(true);
    setConnectionMessage(null);
    setConnectionError(false);
    try {
      const result = await rpc.call("validateKey", hostId ? { hostId } : {});
      setConnectionMessage(result.message);
      setConnectionError(!result.ok);
      await load();
    } catch (cause) {
      setConnectionError(true);
      setConnectionMessage(
        cause instanceof Error ? cause.message : "The connection test failed.",
      );
    } finally {
      setValidating(false);
    }
  };
  const saveConnection = async (
    connection: Pick<NativeModel, "providerId" | "modelId">,
  ) => {
    setSavingConnection(true);
    setConnectionMessage(null);
    setConnectionError(false);
    try {
      await rpc.call("saveNativeClassifier", {
        ...connection,
        ...(hostId ? { hostId } : {}),
      });
      setConnectionMessage("Connection tested and saved.");
      await load();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The connection did not save.";
      throw new Error(message);
    } finally {
      setSavingConnection(false);
    }
  };
  return (
    <DashboardView
      data={data}
      days={days}
      baseline={baseline}
      busy={busy}
      error={error}
      connectionMessage={connectionMessage}
      connectionError={connectionError}
      validating={validating}
      nativeModels={nativeModels}
      modelsBusy={modelsBusy}
      modelsError={modelsError}
      modelsWarnings={modelsWarnings}
      savingConnection={savingConnection}
      onRefreshModels={() => {
        void loadModels();
      }}
      onSaveConnection={saveConnection}
      onDays={setDays}
      onBaseline={setBaseline}
      onRefresh={() => {
        void load();
        void loadModels();
      }}
      onValidate={() => {
        void validate();
      }}
      onThread={(id) => navigate.toThread(id)}
    />
  );
}

function RoutingPage({ subPath }: PluginNavPanelProps) {
  return (
    <RoutingDashboard
      threadId={
        subPath.startsWith("thread/")
          ? subPath.slice("thread/".length)
          : undefined
      }
    />
  );
}

function ThreadRouting({ threadId }: PluginThreadPanelProps) {
  return <RoutingDashboard threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "routing",
    title: "Model Pilot",
    path: "routing",
    icon: "ChartNoAxesCombined",
    component: RoutingPage,
  });
  app.slots.threadPanelAction({
    id: "routing",
    title: "Model Pilot",
    icon: "ChartNoAxesCombined",
    component: ThreadRouting,
    run: ({ openPanel }) => {
      openPanel({ title: "Model Pilot" });
    },
  });
});
