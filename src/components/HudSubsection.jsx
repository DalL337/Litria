/**
 * HudSubsection — a foldable subsection inside a HUD widget (the Grid
 * widget's five, Help's three). The title row is a button; a folded
 * subsection keeps its current value in a chip when it has one.
 */
export default function HudSubsection({ id, title, chip, collapsed, onToggle, className = '', children }) {
  return (
    <div className={`hud-sub${collapsed ? ' is-collapsed' : ''}${className ? ` ${className}` : ''}`} data-section={id}>
      <button
        type="button"
        className="hud-sub-title"
        aria-expanded={!collapsed}
        onClick={() => onToggle(id, !collapsed)}
      >
        <span className="hud-chev" aria-hidden="true" />
        <span className="hud-sub-name">{title}</span>
        {collapsed && chip ? <span className="hud-chip">{chip}</span> : null}
      </button>
      {!collapsed && <div className="hud-sub-body">{children}</div>}
    </div>
  );
}
