import { useCallback, useEffect, useState } from "react";
import { APP_NAME, COPY } from "./copy.js";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; db: string }
  | { kind: "degraded"; db: string }
  | { kind: "error" };

interface HealthPayload {
  status: string;
  db: string;
}

function isHealthPayload(value: unknown): value is HealthPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["status"] === "string" && typeof record["db"] === "string";
}

async function fetchHealth(signal: AbortSignal): Promise<HealthState> {
  let response: Response;
  try {
    response = await fetch("/api/v1/health", { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "loading" };
    }
    return { kind: "error" };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return { kind: "error" };
  }

  if (!isHealthPayload(payload)) {
    return { kind: "error" };
  }

  if (response.ok && payload.status === "ok") {
    return { kind: "ok", db: payload.db };
  }
  return { kind: "degraded", db: payload.db };
}

export function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setHealth({ kind: "loading" });
    void fetchHealth(controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setHealth(next);
      }
    });
    return () => {
      controller.abort();
    };
  }, [reloadToken]);

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <section
        aria-live="polite"
        aria-busy={health.kind === "loading"}
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow"
      >
        <h1 className="text-2xl font-bold text-slate-900">{APP_NAME}</h1>
        <h2 className="mt-1 text-lg font-semibold text-slate-700">{COPY.healthTitle}</h2>
        <p className="mt-1 text-sm text-slate-600">{COPY.healthSubtitle}</p>

        {health.kind === "loading" ? <p className="mt-4 text-sm">{COPY.healthLoading}</p> : null}
        {health.kind === "ok" ? (
          <p className="mt-4 rounded-lg bg-green-100 px-3 py-2 text-sm font-medium text-green-900">
            {COPY.healthOk} ({COPY.dbLabel}: {health.db})
          </p>
        ) : null}
        {health.kind === "degraded" ? (
          <div className="mt-4 rounded-lg bg-amber-100 px-3 py-2">
            <p className="text-sm font-medium text-amber-900">{COPY.healthDegraded}</p>
            <p className="mt-1 text-xs text-amber-800">
              {COPY.apiLabel}: degraded · {COPY.dbLabel}: {health.db}
            </p>
          </div>
        ) : null}
        {health.kind === "error" ? (
          <p className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-900">
            {COPY.healthError}
          </p>
        ) : null}

        {health.kind === "degraded" || health.kind === "error" ? (
          <button
            type="button"
            onClick={handleRetry}
            className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            {COPY.healthRetry}
          </button>
        ) : null}
      </section>
    </main>
  );
}
