import { resolveWizardPreviewColors, resolveWizardPreviewSurface } from '../app/selectors/wizardPreviewColors';

/**
 * WizardStylePreview — the "design your language at a glance" sample on the
 * wizard's Workspace Style + Capstone pages.
 *
 * Colors come from resolveWizardPreviewColors, which runs the SAME
 * resolveNodeEdgeColor cascade the live canvas uses (so the preview can't drift
 * from what a project actually renders) and applies the Live/Calm pastel lens.
 * Calm is a *viewing* lens, not a project setting — the stored project colors
 * are never changed; pick neon green, preview Calm, see pastel green.
 *
 * The node paint here is a CSS representation of the chosen *material* — matte
 * (opaque fill + solid border) vs glass (translucent frosted tint + rim) — driven
 * by resolveWizardPreviewSurface, which reads the same merged preset tokens the
 * canvas resolves. The user's edge hue paints on top (color ⊥ material).
 */

function PreviewNode({ edgeColor, label, surface }) {
  return (
    <div
      className="npw-preview-node"
      data-material={surface?.material}
      style={surface ? {
        background: surface.background,
        border: surface.border,
        borderRadius: surface.borderRadius,
        backdropFilter: surface.backdropFilter,
        WebkitBackdropFilter: surface.backdropFilter
      } : undefined}
    >
      {edgeColor && (
        <span className="npw-preview-node-edge" style={{ background: edgeColor }} />
      )}
      <span className="npw-preview-node-led" style={surface ? { background: surface.ledColor } : undefined} />
      <span className="npw-preview-node-label" style={surface ? { color: surface.color } : undefined}>{label}</span>
    </div>
  );
}

export default function WizardStylePreview({ state }) {
  const { groupColor, memberEdge, standaloneEdge } = resolveWizardPreviewColors(state);
  const surface = resolveWizardPreviewSurface(state?.theme);

  const groupTint = groupColor
    ? { borderColor: `${groupColor}66`, background: `${groupColor}12` }
    : undefined;

  return (
    <div className="npw-style-sample">
      <div className="npw-style-sample-header">
        <span className="npw-style-sample-title">Workspace Style Sample</span>
        <span className="npw-style-sample-badge">PREVIEW</span>
      </div>
      <div className="npw-preview-split">
        <div className="npw-preview-cell">
          <div className="npw-preview-cell-label">Folder Group</div>
          <div className="npw-preview-group" style={groupTint}>
            <PreviewNode edgeColor={memberEdge} label="index.html" surface={surface} />
          </div>
          <div className="npw-preview-caption">
            Members inherit the group color on their left edge.
          </div>
        </div>
        <div className="npw-preview-cell">
          <div className="npw-preview-cell-label">Standalone Piece</div>
          <PreviewNode edgeColor={standaloneEdge} label="readme.md" surface={surface} />
          <div className="npw-preview-caption">
            {state?.nodeColorMode === 'custom'
              ? 'Starts with your chosen color.'
              : 'No edge until grouped or set.'}
          </div>
        </div>
      </div>
    </div>
  );
}
