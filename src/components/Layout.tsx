import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useRealtime } from "../lib/realtime";
import type { Permission } from "../lib/types";

const LINKS: Array<{ to: string; label: string; permission?: Permission }> = [
  { to: "/files", label: "Archivos", permission: "files:read" },
  { to: "/refiners", label: "Expedientes", permission: "refiners:read" },
  { to: "/incidents", label: "Incidentes", permission: "incidents:read" },
  { to: "/estado", label: "Estado" },
];

function ConnectionBadge(): JSX.Element {
  const { status } = useRealtime();
  const map = {
    open: { label: "En vivo", className: "bg-lumon-mint" },
    connecting: { label: "Conectando", className: "bg-lumon-amber" },
    closed: { label: "Sin conexión", className: "bg-lumon-danger" },
    unavailable: { label: "Piso cerrado", className: "bg-lumon-line" },
  } as const;
  const current = map[status];
  return (
    <span className="inline-flex items-center gap-2 text-xs text-lumon-mint/70" title={`Eventos: ${current.label}`}>
      <span className={`h-2 w-2 rounded-full ${current.className}`} aria-hidden="true" />
      <span className="hidden sm:inline">{current.label}</span>
    </span>
  );
}

export function Layout(): JSX.Element {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

  const onLogout = async (): Promise<void> => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-lumon-ink text-lumon-mint">
      <header className="border-b border-lumon-line bg-lumon-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <NavLink to="/files" className="font-mono text-sm font-bold tracking-[0.25em] text-lumon-mint">
            LUMON<span className="text-lumon-mintDim">/</span>MDR
          </NavLink>
          <nav aria-label="Principal" className="flex flex-wrap items-center gap-1">
            {LINKS.filter((link) => !link.permission || hasPermission(link.permission)).map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  `rounded px-3 py-1.5 text-sm ${
                    isActive ? "bg-lumon-mint/15 text-lumon-mint" : "text-lumon-mint/70 hover:text-lumon-mint"
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <ConnectionBadge />
            <div className="text-right">
              <p className="text-sm text-lumon-mint">{user?.displayName ?? "—"}</p>
              <p className="font-mono text-[11px] text-lumon-mint/50">
                {user?.team.code ?? ""} · {user?.role.name ?? ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="rounded border border-lumon-line px-3 py-1.5 text-sm text-lumon-mint/80 hover:border-lumon-mint/40"
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
