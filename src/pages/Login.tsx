import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { fieldErrors, isApiError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { safeNext } from "../lib/nav";

function errorField(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const details = error.details;
  if (typeof details === "object" && details !== null && "field" in details) {
    const field = (details as { field?: unknown }).field;
    if (typeof field === "string") return field;
  }
  return null;
}

export function LoginPage(): JSX.Element {
  const { status, login, revokedMessage } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to={next} replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (caught) {
      const fields = fieldErrors(caught);
      const field = errorField(caught) ?? Object.keys(fields)[0] ?? null;
      if (field) {
        setFieldError({ field, message: fields[field] ?? messageFor(caught) });
        window.setTimeout(() => document.getElementById(field)?.focus(), 0);
      }
      else setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-lumon-ink p-6">
      <div className="w-full max-w-md rounded-lg border border-lumon-line bg-lumon-panel p-8">
        <p className="font-mono text-xs tracking-[0.3em] text-lumon-mintDim">LUMON INDUSTRIES</p>
        <h1 className="mt-2 text-2xl font-semibold text-lumon-mint">Macrodata Refinement</h1>
        <p className="mt-1 text-sm text-lumon-mint/60">El trabajo es misterioso e importante.</p>

        {revokedMessage ? (
          <p role="alert" className="mt-4 rounded border border-lumon-amber/50 bg-lumon-amber/10 p-3 text-sm text-lumon-amber">
            {revokedMessage}
          </p>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
          <div>
            <label htmlFor="email" className="block text-sm text-lumon-mint/80">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={fieldError?.field === "email"}
              aria-describedby={fieldError?.field === "email" ? "email-error" : undefined}
              className="mt-1 w-full rounded border border-lumon-line bg-lumon-ink px-3 py-2 text-lumon-mint outline-none focus:border-lumon-mint"
            />
            {fieldError?.field === "email" ? (
              <p id="email-error" role="alert" className="mt-1 text-sm text-lumon-danger">
                {fieldError.message}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="password" className="block text-sm text-lumon-mint/80">
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldError?.field === "password"}
              aria-describedby={fieldError?.field === "password" ? "password-error" : undefined}
              className="mt-1 w-full rounded border border-lumon-line bg-lumon-ink px-3 py-2 text-lumon-mint outline-none focus:border-lumon-mint"
            />
            {fieldError?.field === "password" ? (
              <p id="password-error" role="alert" className="mt-1 text-sm text-lumon-danger">
                {fieldError.message}
              </p>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="rounded border border-lumon-danger/50 bg-lumon-danger/10 p-3 text-sm text-lumon-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-lumon-mint px-4 py-2 font-semibold text-lumon-ink disabled:opacity-60"
          >
            {busy ? "Entrando…" : "Entrar al piso"}
          </button>
        </form>

        <p className="mt-5 text-sm text-lumon-mint/60">
          ¿Sin cuadrilla?{" "}
          <Link to={`/register?next=${encodeURIComponent(next)}`} className="text-lumon-mint underline">
            Registrar equipo
          </Link>
        </p>
      </div>
    </main>
  );
}
