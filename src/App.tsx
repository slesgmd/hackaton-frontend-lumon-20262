import { Suspense, lazy, useEffect, type ComponentType, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { FullScreenLoading, Loading } from "./components/Loading";
import { ProtectedRoute } from "./components/ProtectedRoute";
import type { Permission } from "./lib/types";

function page<T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) {
  return lazy(async () => ({ default: (await loader())[name] as ComponentType }));
}

const LoginPage = page(() => import("./pages/Login"), "LoginPage");
const RegisterPage = page(() => import("./pages/Register"), "RegisterPage");
const FilesPage = page(() => import("./pages/Files"), "FilesPage");
const RefinePage = page(() => import("./pages/Refine"), "RefinePage");
const RefinersPage = page(() => import("./pages/Refiners"), "RefinersPage");
const RefinerDetailPage = page(() => import("./pages/RefinerDetail"), "RefinerDetailPage");
const RefinerEditPage = page(() => import("./pages/RefinerEdit"), "RefinerEditPage");
const RefinerBadgePage = page(() => import("./pages/RefinerBadge"), "RefinerBadgePage");
const IncidentsPage = page(() => import("./pages/Incidents"), "IncidentsPage");
const IncidentNewPage = page(() => import("./pages/IncidentNew"), "IncidentNewPage");
const EstadoPage = page(() => import("./pages/Estado"), "EstadoPage");
const NotFoundPage = page(() => import("./pages/NotFound"), "NotFoundPage");

function Shell({ title, children, full = false }: { title: string; children: ReactNode; full?: boolean }): JSX.Element {
  useEffect(() => {
    document.title = `${title} · Lumon MDR`;
  }, [title]);
  return (
    <ErrorBoundary>
      <Suspense fallback={full ? <FullScreenLoading label="Cargando…" /> : <Loading />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function Guarded({
  title,
  permission,
  children,
}: {
  title: string;
  permission?: Permission;
  children: ReactNode;
}): JSX.Element {
  return (
    <Shell title={title}>
      {permission ? <ProtectedRoute permission={permission}>{children}</ProtectedRoute> : <>{children}</>}
    </Shell>
  );
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Shell title="Iniciar sesión" full>
            <LoginPage />
          </Shell>
        }
      />
      <Route
        path="/register"
        element={
          <Shell title="Registrar cuadrilla" full>
            <RegisterPage />
          </Shell>
        }
      />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          path="/"
          element={
            <Guarded title="Archivos" permission="files:read">
              <FilesPage />
            </Guarded>
          }
        />
        <Route
          path="/files"
          element={
            <Guarded title="Archivos" permission="files:read">
              <FilesPage />
            </Guarded>
          }
        />
        <Route
          path="/files/:id/refine"
          element={
            <Guarded title="Refinar" permission="files:read">
              <RefinePage />
            </Guarded>
          }
        />
        <Route
          path="/refiners"
          element={
            <Guarded title="Expedientes" permission="refiners:read">
              <RefinersPage />
            </Guarded>
          }
        />
        <Route
          path="/refiners/:id"
          element={
            <Guarded title="Expediente" permission="refiners:read">
              <RefinerDetailPage />
            </Guarded>
          }
        />
        <Route
          path="/refiners/:id/edit"
          element={
            <Guarded title="Editar expediente" permission="refiners:write">
              <RefinerEditPage />
            </Guarded>
          }
        />
        <Route
          path="/refiners/:id/badge"
          element={
            <Guarded title="Fotocheck" permission="media:upload">
              <RefinerBadgePage />
            </Guarded>
          }
        />
        <Route
          path="/incidents"
          element={
            <Guarded title="Incidentes" permission="incidents:read">
              <IncidentsPage />
            </Guarded>
          }
        />
        <Route
          path="/incidents/new"
          element={
            <Guarded title="Nuevo reporte" permission="incidents:create">
              <IncidentNewPage />
            </Guarded>
          }
        />
        <Route
          path="/estado"
          element={
            <Guarded title="Estado">
              <EstadoPage />
            </Guarded>
          }
        />
      </Route>
      <Route
        path="*"
        element={
          <Shell title="No encontrada" full>
            <NotFoundPage />
          </Shell>
        }
      />
    </Routes>
  );
}
