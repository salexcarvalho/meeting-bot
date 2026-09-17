import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Header } from "./Header";
import { MobileDrawer } from "./MobileDrawer";
import { NAV_GROUPS, visibleGroups, type NavGroup } from "./nav";
import { Sidebar, type ShellUser } from "./Sidebar";

export function AppShell({
  user,
  can,
  groups = NAV_GROUPS,
  onPassword,
  onLogout,
  headerSlot,
  children,
}: {
  user: ShellUser;
  can: (permission: string) => boolean;
  groups?: NavGroup[];
  onPassword: () => void;
  onLogout: () => void;
  headerSlot?: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const nav = useMemo(() => visibleGroups(groups, can), [groups, can]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      <Sidebar groups={nav} user={user} onPassword={onPassword} onLogout={onLogout} />
      <div className="app-column">
        <Header onMenu={() => setMenuOpen(true)} menuOpen={menuOpen}>
          {headerSlot}
        </Header>
        <div className="app-content" id="conteudo" tabIndex={-1}>
          {children}
        </div>
      </div>
      <MobileDrawer
        open={menuOpen}
        onClose={closeMenu}
        groups={nav}
        user={user}
        onPassword={onPassword}
        onLogout={onLogout}
      />
    </div>
  );
}
