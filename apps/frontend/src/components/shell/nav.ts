import { CalendarDays, FolderKanban, Settings, Users, Video, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  // Permissão exigida para exibir o item. O backend continua validando o acesso.
  permission?: string;
}

export interface NavGroup {
  id: string;
  label: string; // só para leitores de tela; os grupos não têm título visível
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "pessoal",
    label: "Pessoal",
    items: [{ to: "/", label: "Hoje", icon: CalendarDays, end: true }],
  },
  {
    id: "reunioes",
    label: "Reuniões",
    items: [
      { to: "/reunioes", label: "Reuniões", icon: Video },
      { to: "/projetos", label: "Projetos", icon: FolderKanban },
    ],
  },
  {
    id: "sistema",
    label: "Sistema",
    items: [
      { to: "/configuracoes", label: "Configurações", icon: Settings },
      { to: "/admin/usuarios", label: "Usuários", icon: Users, permission: "users.read" },
    ],
  },
];

export function visibleGroups(groups: NavGroup[], can: (permission: string) => boolean): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) }))
    .filter((g) => g.items.length > 0);
}
