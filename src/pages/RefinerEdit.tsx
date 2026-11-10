import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { ErrorNotice, Loading } from "../components/Loading";
import { apiRequest, apiRequestWithMeta, isAbortError, isApiError, messageFor } from "../lib/api";
import { useRealtimeEvent } from "../lib/realtime";
import { reconcile } from "../lib/refinerStore";
import { DepartmentSchema, RefinerSchema, RefinerUpdatedEventSchema } from "../lib/schemasCp4";
import type { Department, Refiner, RefinerPatch } from "../lib/types";

type FieldKey = "title" | "extension" | "bio" | "departmentId";

interface FormState {
  title: string;
  extension: string;
  bio: string;
  departmentId: string;
}

interface Conflict {
  /** Lo que hay ahora en el servidor. */
  server: Refiner;
  /** ETag de esa versión, para reintentar con él. */
  etag: string;
  /** Lo que yo escribí. */
  mine: FormState;
  /** Versión sobre la que empecé a editar. */
  base: FormState;
  /** Elección por campo. */
  choice: Record<FieldKey, "mine" | "server">;
}

const FIELDS: Array<{ key: FieldKey; label: string }> = [
  { key: "title", label: "Cargo" },
  { key: "extension", label: "Extensión" },
  { key: "bio", label: "Biografía" },
  { key: "departmentId", label: "Departamento" },
];

function formFrom(refiner: Refiner): FormState {
  return {
    title: refiner.title,
    extension: refiner.extension,
    bio: refiner.bio,
    departmentId: String(refiner.department.id),
  };
}

function valueOf(state: FormState, key: FieldKey, departments: Department[]): string {
  if (key !== "departmentId") return state[key];
  return departments.find((department) => String(department.id) === state.departmentId)?.name ?? state.departmentId;
}

/** Solo manda los campos que cambian respecto de `from`. */
function diff(next: FormState, from: FormState): RefinerPatch {
  const patch: RefinerPatch = {};
  if (next.title.trim() !== from.title) patch.title = next.title.trim();
  if (next.extension.trim() !== from.extension) patch.extension = next.extension.trim();
  if (next.bio !== from.bio) patch.bio = next.bio;
  if (next.departmentId !== from.departmentId) patch.departmentId = Number(next.departmentId);
  return patch;
}

function etagFrom(headers: string | null, version: number): string {
  return headers ?? `"${version}"`;
}

export function RefinerEditPage(): JSX.Element {
  const { id } = useParams();
  const refinerId = Number(id);
  const navigate = useNavigate();
  const [refiner, setRefiner] = useState<Refiner | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!Number.isInteger(refinerId) || refinerId <= 0) {
      setError("El expediente no existe.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, { signal: controller.signal }),
      apiRequest<unknown>("/departments", { signal: controller.signal }),
    ])
      .then(([result, rawDepartments]) => {
        const parsed = reconcile(RefinerSchema.parse(result.data));
        setRefiner(parsed);
        // El If-Match usa el ETag exacto del GET.
        setEtag(etagFrom(result.etag, parsed.version));
        setForm(formFrom(parsed));
        setDepartments(z.array(DepartmentSchema).parse(rawDepartments));
        setRemoteVersion(null);
      })
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) setError(messageFor(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refinerId, reloadKey]);

  // Si llega una versión más nueva mientras se edita, se avisa antes de guardar.
  useRealtimeEvent("refiner.updated", (event) => {
    const parsed = RefinerUpdatedEventSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.id !== refinerId) return;
    reconcile(parsed.data.refiner);
    setRefiner((current) => {
      if (current && parsed.data.version > current.version) setRemoteVersion(parsed.data.version);
      return current;
    });
  });

  const base = useMemo(() => (refiner ? formFrom(refiner) : null), [refiner]);
  const dirty = useMemo(() => {
    if (!base || !form) return false;
    return Object.keys(diff(form, base)).length > 0;
  }, [base, form]);

  const openConflict = (server: Refiner, serverEtag: string, mine: FormState, baseState: FormState): void => {
    const serverState = formFrom(server);
    const choice = {} as Record<FieldKey, "mine" | "server">;
    for (const { key } of FIELDS) {
      const iEdited = mine[key] !== baseState[key];
      const serverEdited = serverState[key] !== baseState[key];
      // Por defecto se conserva lo que cada parte cambió; si ambos cambiaron el mismo campo, el usuario decide.
      choice[key] = iEdited && !serverEdited ? "mine" : "server";
    }
    setConflict({ server, etag: serverEtag, mine, base: baseState, choice });
  };

  const patch = async (body: RefinerPatch, match: string, mine: FormState, baseState: FormState): Promise<void> => {
    try {
      const result = await apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, {
        method: "PATCH",
        headers: { "If-Match": match },
        body,
        retries: 0,
      });
      const updated = reconcile(RefinerSchema.parse(result.data));
      setRefiner(updated);
      setEtag(etagFrom(result.etag, updated.version));
      setForm(formFrom(updated));
      setConflict(null);
      setRemoteVersion(null);
      navigate(`/refiners/${refinerId}`, { replace: true });
    } catch (caught) {
      if (isApiError(caught) && caught.status === 412) {
        const parsed = RefinerSchema.safeParse((caught.details as { current?: unknown } | null)?.current);
        if (parsed.success) {
          const server = reconcile(parsed.data);
          // Nunca se sobrescribe en silencio: se muestra el conflicto y se elige campo por campo.
          openConflict(server, etagFrom(caught.etag, server.version), mine, baseState);
          return;
        }
        setError("El expediente cambió mientras lo editabas. Vuelve a cargarlo para ver la versión actual.");
        return;
      }
      if (isApiError(caught) && caught.status === 422 && caught.code === "VALIDATION_ERROR") {
        const fields = (caught.details as { fields?: Record<string, string> } | null)?.fields ?? {};
        setFieldErrors(fields);
        return;
      }
      setError(messageFor(caught));
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!form || !base || !refiner || !etag || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      if (remoteVersion !== null) {
        // Avisa antes de guardar: compara contra lo que hay ahora en el servidor.
        const fresh = await apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, { retries: 2 });
        const server = reconcile(RefinerSchema.parse(fresh.data));
        if (server.version > refiner.version) {
          openConflict(server, etagFrom(fresh.etag, server.version), form, base);
          return;
        }
      }
      const body = diff(form, base);
      if (Object.keys(body).length === 0) return;
      await patch(body, etag, form, base);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const retryWithChoice = async (): Promise<void> => {
    if (!conflict || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const serverState = formFrom(conflict.server);
      const merged = { ...serverState };
      for (const { key } of FIELDS) merged[key] = conflict.choice[key] === "mine" ? conflict.mine[key] : serverState[key];
      const body = diff(merged, serverState);
      if (Object.keys(body).length === 0) {
        // Se eligió todo del servidor: no hay nada que enviar, solo se adopta esa versión.
        setRefiner(conflict.server);
        setEtag(conflict.etag);
        setForm(serverState);
        setConflict(null);
        setRemoteVersion(null);
        return;
      }
      // Reintento con el ETag nuevo (el de la versión que acabo de ver).
      await patch(body, conflict.etag, merged, serverState);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (loading && !refiner) return <Loading label="Cargando expediente…" />;
  if (error && !refiner) {
    return (
      <section>
        <ErrorNotice message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        <Link to="/refiners" className="mt-4 inline-block text-sm text-lumon-mint underline">
          Volver al directorio
        </Link>
      </section>
    );
  }
  if (!refiner || !form) return <Loading />;

  const inputClass =
    "mt-1 w-full rounded border border-lumon-line bg-lumon-ink px-3 py-2 text-sm text-lumon-mint aria-[invalid=true]:border-lumon-danger";

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link to={`/refiners/${refinerId}`} className="text-xs text-lumon-mint/60 underline">
          ← Expediente
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-lumon-mint">Editar expediente</h1>
        <p className="font-mono text-xs text-lumon-mint/40">
          Versión {refiner.version} · ETag {etag ?? "—"}
        </p>
      </div>

      {remoteVersion !== null && !conflict ? (
        <p role="alert" className="rounded border border-lumon-amber/50 bg-lumon-amber/10 p-3 text-sm text-lumon-amber">
          Alguien actualizó este expediente (versión {remoteVersion}) mientras editabas. Al guardar te mostraremos las
          diferencias para que decidas qué conservar.
        </p>
      ) : null}

      {error ? <ErrorNotice message={error} /> : null}

      {conflict ? (
        <div role="alert" className="rounded border border-lumon-danger/50 bg-lumon-danger/10 p-4">
          <h2 className="text-sm font-semibold text-lumon-danger">
            Conflicto de versión (servidor en la versión {conflict.server.version})
          </h2>
          <p className="mt-1 text-sm text-lumon-mint/80">
            El expediente cambió desde que lo abriste. Elige, campo por campo, qué conservar. No se guarda nada hasta que
            confirmes.
          </p>
          <div className="mt-3 space-y-3">
            {FIELDS.map(({ key, label }) => {
              const serverState = formFrom(conflict.server);
              const differs = conflict.mine[key] !== serverState[key];
              return (
                <fieldset key={key} className="rounded border border-lumon-line/70 p-3">
                  <legend className="px-1 text-xs text-lumon-mint/70">
                    {label}
                    {!differs ? " · sin diferencias" : ""}
                  </legend>
                  {(["mine", "server"] as const).map((side) => (
                    <label key={side} className="mt-1 flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name={`choice-${key}`}
                        checked={conflict.choice[key] === side}
                        onChange={() => setConflict({ ...conflict, choice: { ...conflict.choice, [key]: side } })}
                        disabled={!differs}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-xs text-lumon-mint/50">{side === "mine" ? "Lo que escribí" : "Lo que hay en el servidor"}</span>
                        <span className="block max-w-full whitespace-pre-wrap break-words text-lumon-mint">
                          {valueOf(side === "mine" ? conflict.mine : serverState, key, departments) || "—"}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void retryWithChoice()}
              disabled={saving}
              className="rounded bg-lumon-mint px-3 py-1.5 text-sm font-semibold text-lumon-ink disabled:opacity-50"
            >
              {saving ? "Guardando…" : "Guardar mi selección"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRefiner(conflict.server);
                setEtag(conflict.etag);
                setForm(formFrom(conflict.server));
                setConflict(null);
                setRemoteVersion(null);
              }}
              className="rounded border border-lumon-line px-3 py-1.5 text-sm text-lumon-mint"
            >
              Descartar lo mío
            </button>
            <button
              type="button"
              onClick={() => setConflict(null)}
              className="rounded border border-lumon-line px-3 py-1.5 text-sm text-lumon-mint/70"
            >
              Seguir editando
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4 rounded border border-lumon-line bg-lumon-panel p-4" noValidate>
        <div>
          <label htmlFor="title" className="block text-xs text-lumon-mint/60">
            Cargo
          </label>
          <input
            id="title"
            required
            maxLength={200}
            value={form.title}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={fieldErrors.title ? "title-error" : undefined}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            className={inputClass}
          />
          {fieldErrors.title ? <p id="title-error" className="mt-1 text-xs text-lumon-danger">{fieldErrors.title}</p> : null}
        </div>
        <div>
          <label htmlFor="extension" className="block text-xs text-lumon-mint/60">
            Extensión (3 a 6 dígitos)
          </label>
          <input
            id="extension"
            required
            inputMode="numeric"
            pattern="[0-9]{3,6}"
            value={form.extension}
            aria-invalid={fieldErrors.extension ? true : undefined}
            aria-describedby={fieldErrors.extension ? "extension-error" : undefined}
            onChange={(event) => setForm({ ...form, extension: event.target.value })}
            className={inputClass}
          />
          {fieldErrors.extension ? <p id="extension-error" className="mt-1 text-xs text-lumon-danger">{fieldErrors.extension}</p> : null}
        </div>
        <div>
          <label htmlFor="departmentId" className="block text-xs text-lumon-mint/60">
            Departamento
          </label>
          <select
            id="departmentId"
            value={form.departmentId}
            onChange={(event) => setForm({ ...form, departmentId: event.target.value })}
            className={inputClass}
          >
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bio" className="block text-xs text-lumon-mint/60">
            Biografía
          </label>
          <textarea
            id="bio"
            rows={5}
            maxLength={2000}
            value={form.bio}
            aria-invalid={fieldErrors.bio ? true : undefined}
            aria-describedby={fieldErrors.bio ? "bio-error" : undefined}
            onChange={(event) => setForm({ ...form, bio: event.target.value })}
            className={inputClass}
          />
          {fieldErrors.bio ? <p id="bio-error" className="mt-1 text-xs text-lumon-danger">{fieldErrors.bio}</p> : null}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-lumon-mint/50">{dirty ? "Cambios sin guardar" : "Sin cambios"}</span>
          <button
            type="submit"
            disabled={saving || !dirty}
            className="rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-50"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </section>
  );
}
