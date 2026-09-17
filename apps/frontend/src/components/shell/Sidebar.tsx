import { AudioLines, KeyRound, LogOut } from "lucide-react";
import { Link, NavLink } from "react-router";
import type { NavGroup } from "./nav";

export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/" className="brand" onClick={onNavigate}>
      <span className="brand-mark" aria-hidden="true">
        <AudioLines size={20} />
      </span>
      <span className="brand-name">Agente de Reuniões</span>
    </Link>
  );
}

export function NavList({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Principal">
      <ul className="nav-groups">
        {groups.map((group) => (
          <li key={group.id}>
            <ul className="nav-group" aria-label={group.label}>
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="nav-link" onClick={onNavigate}>
                    <item.icon size={16} />
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export interface ShellUser {
  name: string;
  username: string;
  /** URL da foto (com versão) ou null para as iniciais */
  avatarUrl?: string | null;
}

export function UserBox({ user, onPassword, onLogout }: { user: ShellUser; onPassword: () => void; onLogout: () => void }) {
  return (
    <div className="user-box">
      <span className="avatar" aria-hidden="true">
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials(user.name)}
      </span>
      <div className="grow">
        <div className="user-box-name" title={user.name}>{user.name}</div>
        {user.name !== user.username && <div className="user-box-sub">@{user.username}</div>}
        <div className="user-box-actions">
          <button type="button" className="ghost small" onClick={onPassword}>
            <KeyRound aria-hidden="true" /> Senha
          </button>
          <button type="button" className="ghost small" onClick={onLogout}>
            <LogOut aria-hidden="true" /> Sair
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  groups,
  user,
  onPassword,
  onLogout,
}: {
  groups: NavGroup[];
  user: ShellUser;
  onPassword: () => void;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar">
      <Brand />
      <div className="sidebar-nav">
        <NavList groups={groups} />
      </div>
      <UserBox user={user} onPassword={onPassword} onLogout={onLogout} />
    </aside>
  );
}
