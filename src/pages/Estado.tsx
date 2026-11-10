import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { ErrorNotice, Loading } from "../components/Loading";
import { apiRequest, isAbortError, isApiError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { env } from "../lib/env";
import { formatDate } from "../lib/format";
import { ClearanceCheckResultSchema, ClearanceSchema, IntegrationStatusSchema } from "../lib/schemas";
import type { z } from "zod";

type Clearance = z.infer<typeof ClearanceSchema>;
type Integrations = z.infer<typeof IntegrationStatusSchema>;
type CheckResult = z.infer<typeof ClearanceCheckResultSchema>;

const CHECK_LABEL: Record<string, string> = {
  DEPLOY: "Despliegue",
  SESSION: "Sesión",
  GRID: "Grilla",
  REFINE: "Refinamiento",
};

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-lumon-line/60 py-2 text-sm first:border-t-0">
      <dt className="text-lumon-mint/60">{label}</dt>
      <dd className="font-mono text-xs text-lumon-mint">{children}</dd>
    </div>
  );
}

function Ok({ ok, yes, no }: { ok: boolean; yes: string; no: string }): JSX.Element {
  return (
    <span className={ok ? "text-lumon-mint" : "text-lumon-amber"}>
      <span aria-hidden="true">{ok ? "● " : "○ "}</span>
      {ok ? yes : no}
    </span>
  );
}

export function EstadoPage(): JSX.Element {
  const { refreshMe } = useAuth();
  const [health, setHealth] = useState<"checking" | "ok" | "down">("checking");
  const [clearance, setClearance] = useState<Clearance | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHealth("checking");

    apiRequest<unknown>("/meta/health", { anonymous: true, signal: controller.signal, skipAuthRefresh: true })
      .then(() => setHealth("ok"))
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) setHealth("down");
      });

    Promise.all([
      apiRequest<unknown>("/clearance", { signal: controller.signal }),
      apiRequest<unknown>("/integrations/status", { signal: controller.signal }),
    ])
      .then(([rawClearance, rawIntegrations]) => {
        setClearance(ClearanceSchema.parse(rawClearance));
        setIntegrations(IntegrationStatusSchema.parse(rawIntegrations));
      })
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) setError(messageFor(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reloadKey]);

  // La revisión automática exige uso real desde la app desplegada: solo corre por acción del usuario.
  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckError(null);
    try {
      const raw = await apiRequest<unknown>("/clearance/check", { method: "POST", retries: 0 });
      const parsed = ClearanceCheckResultSchema.parse(raw);
      setResult(parsed);
      setClearance((previous) =>
        previous ? { ...previous, granted: parsed.granted, grantedAt: parsed.grantedAt, checks: parsed.checks } : previous,
      );
      if (parsed.granted) await refreshMe();
    } catch (caught) {
      if (isApiError(caught) && caught.code === "CHECK_FROM_APP_REQUIRED") {
        setCheckError("La revisión solo corre desde la app desplegada con el dominio verificado.");
      } else {
        setCheckError(messageFor(caught));
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [refreshMe]);

  const checks = result?.checks ?? clearance?.checks ?? [];
  const granted = result?.granted ?? clearance?.granted ?? false;

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-lumon-mint">Estado</h1>
        <p className="text-sm text-lumon-mint/60">Despliegue, integraciones y apertura del Piso de Pruebas.</p>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => setReloadKey((value) => value + 1)} /> : null}
      {loading && !clearance ? <Loading label="Consultando el estado…" /> : null}

      <dl className="rounded border border-lumon-line bg-lumon-panel px-4 py-2">
        <Row label="Build desplegado">{env.build}</Row>
        <Row label="API">
          {health === "checking" ? "Comprobando…" : <Ok ok={health === "ok"} yes="responde" no="no responde" />}
        </Row>
        {integrations ? (
          <>
            <Row label="Dominio verificado">
              <Ok ok={Boolean(integrations.deploy.verifiedAt)} yes={integrations.deploy.origin ?? "verificado"} no="sin verificar" />
            </Row>
            <Row label="Último build visto por la API">{integrations.deploy.lastBuildSeen ?? "—"}</Row>
            <Row label="Storage">
              <Ok
                ok={Boolean(integrations.storage.verifiedAt)}
                yes={`${integrations.storage.provider ?? ""} verificado`}
                no={integrations.storage.provider ? `${integrations.storage.provider} sin verificar` : "sin configurar"}
              />
            </Row>
          </>
        ) : null}
        {clearance ? (
          <>
            <Row label="Piso de Pruebas">
              <Ok ok={granted} yes={`abierto${clearance.grantedAt ? ` · ${formatDate(clearance.grantedAt)}` : ""}`} no="cerrado" />
            </Row>
            <Row label="Caos del workspace">nivel {clearance.workspace.chaosLevel}</Row>
            <Row label="Ronda de control">
              <Ok ok={clearance.round.approved} yes="aprobada" no="sin aprobar" />
            </Row>
          </>
        ) : null}
      </dl>

      <div className="rounded border border-lumon-line bg-lumon-panel p-4">
        <h2 className="text-sm font-semibold text-lumon-mint">Revisión automática</h2>
        <p className="mt-1 text-xs text-lumon-mint/60">
          Comprueba el uso real de la app desplegada de los últimos 15 minutos. Se puede correr las veces que haga falta.
        </p>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checking || granted}
          className="mt-3 rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-50"
        >
          {checking ? "Revisando…" : granted ? "Piso de Pruebas abierto" : "Abrir el Piso de Pruebas"}
        </button>
        {checkError ? (
          <div className="mt-3">
            <ErrorNotice message={checkError} />
          </div>
        ) : null}
        {checks.length > 0 ? (
          <ul className="mt-4 space-y-2" aria-label="Comprobaciones">
            {checks.map((check) => (
              <li key={check.name} className="rounded border border-lumon-line/70 p-3 text-sm">
                <p className={check.passed ? "text-lumon-mint" : "text-lumon-amber"}>
                  <span aria-hidden="true">{check.passed ? "✔ " : "✖ "}</span>
                  <strong>{CHECK_LABEL[check.name] ?? check.name}</strong>
                  <span className="sr-only">{check.passed ? " aprobada" : " no aprobada"}</span>
                </p>
                <p className="mt-1 text-xs text-lumon-mint/60">{check.detail}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-lumon-mint/50">Todavía no se ha corrido la revisión.</p>
        )}
      </div>
    </section>
  );
}
