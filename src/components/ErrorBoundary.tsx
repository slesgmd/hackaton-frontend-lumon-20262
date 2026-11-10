import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkError, reloadOnce } from "../lib/reload";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Error de render", error, info);
    // Un módulo de una versión anterior ya no existe: recarga una sola vez para tomar la versión nueva.
    if (isChunkError(error)) reloadOnce();
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-lumon-ink p-6">
          <div className="max-w-lg rounded-lg border border-lumon-danger/50 bg-lumon-panel p-6">
            <h1 className="text-lg font-semibold text-lumon-danger">Algo falló en el piso</h1>
            <p className="mt-2 text-sm text-lumon-mint/80">
              {isChunkError(this.state.error)
                ? "Hay una versión nueva de la consola. Recarga la página para continuar."
                : "La ruta no pudo renderizarse. El resto de la consola sigue disponible."}
            </p>
            <p className="mt-3 break-words font-mono text-xs text-lumon-mint/50">{this.state.error.message}</p>
            <div className="mt-5 flex gap-3">
              <a
                href="/files"
                className="rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink"
              >
                Volver a archivos
              </a>
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="rounded border border-lumon-line px-4 py-2 text-sm text-lumon-mint"
              >
                Reintentar
              </button>
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
