import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description && <p className="page-header-desc">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

export function CardHead({ title, icon: Icon, actions }: { title: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="card-head">
      <h2>
        {Icon && <Icon size={16} />}
        {title}
      </h2>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Kpi({ label, value, foot, icon: Icon }: { label: ReactNode; value: ReactNode; foot?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        {Icon && <Icon size={14} />}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={32} />}
      <div className="empty-state-title">{title}</div>
      {children && <p className="empty-state-text">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Carregando">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton skeleton-line" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label = "Carregando" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}
