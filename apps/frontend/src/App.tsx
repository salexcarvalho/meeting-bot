import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { api, onUnauthorized } from "./api";
import { PasswordDialog } from "./components/PasswordDialog";
import { AppShell } from "./components/shell/AppShell";
import { ToastProvider } from "./components/Toast";
import { live } from "./live";
import { Configuracoes } from "./pages/Configuracoes";
import { Hoje } from "./pages/Hoje";
import { Usuarios } from "./pages/admin/Usuarios";
import { Login } from "./pages/Login";
import { Projetos } from "./pages/Projetos";
import { Reuniao } from "./pages/Reuniao";
import { Reunioes } from "./pages/Reunioes";

import { SessionContext, SessionRefreshContext, type Session } from "./session";

export type { Session };

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => {
    api<Session>("/auth/me")
      .then(setSession)
      .catch(() => setSession(null));
    return onUnauthorized(() => setSession(null));
  }, []);

  useEffect(() => {
    if (session) live.start();
    else live.stop();
  }, [session]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setSession(null);
  }, []);
  const openPassword = useCallback(() => setPasswordOpen(true), []);
  const refreshSession = useCallback(async () => {
    await api<Session>("/auth/me").then(setSession).catch(() => {});
  }, []);
  // O backend valida o acesso de qualquer forma; aqui só escondemos o que não se aplica.
  const can = useCallback((permission: string) => Boolean(session?.permissions.includes(permission as never)), [session]);

  if (session === undefined) return null;

  return (
    <ToastProvider>
      {session === null ? (
        <Login onLogin={setSession} />
      ) : (
        <SessionContext.Provider value={session}>
          <SessionRefreshContext.Provider value={refreshSession}>
          <AppShell
            user={{
              name: session.displayName || session.user.username,
              username: session.user.username,
              avatarUrl: session.avatarVersion ? `/api/me/avatar?v=${session.avatarVersion}` : null,
            }}
            can={can}
            onPassword={openPassword}
            onLogout={logout}
          >
            <Routes>
              <Route path="/" element={<Hoje />} />
              <Route path="/reunioes" element={<Reunioes />} />
              <Route path="/reunioes/:id" element={<Reuniao />} />
              <Route path="/projetos" element={<Projetos />} />
              <Route path="/configuracoes" element={<Configuracoes />} />
              <Route path="/admin/usuarios" element={can("users.read") ? <Usuarios /> : <Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
          <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
          </SessionRefreshContext.Provider>
        </SessionContext.Provider>
      )}
    </ToastProvider>
  );
}
