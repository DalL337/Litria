import { useEffect, useMemo, useState } from 'react';
import { entriesForPlace, PREF_KEYS } from '../preferences/registry.js';
import { prefsLoadGlobal, prefsSaveGlobal } from '../preferences/preferencesStore.js';
import { createThemeDomain } from '../app/themeDomain';
import {
  lspInstallServer,
  lspReverifyServer,
  lspServerInventory,
  lspUninstallServer
} from '../lsp/lspClient.js';
import {
  formatBytes,
  groupInventoryRows,
  reverifyMessage,
  rowActions,
  rowStatusLine,
  tierBadge,
  uninstallSummary
} from '../app/serverInventoryModel.js';

/**
 * PreferencesPanel — the Preferences surface (ADR-019).
 *
 * Two callers, one renderer:
 * - Launcher (`projectContext` null): global scope only — no project is open,
 *   so there is nothing to override. Loads appearance itself.
 * - In-app (File → Preferences…): Global + This Project scope tabs. Receives
 *   the LIVE theme state as props (self-loading would desync the open
 *   workspace) and the project energy override + setters.
 *
 * Rows render from registry queries ('preferences.global' /
 * 'preferences.project'); captions are always visible, never tooltips.
 */
function PreferencesPanel({
  projectContext = null,
  energyLevel,
  onApplyEnergyLevel,
  projectEnergyLevel = null,
  onSetProjectEnergy,
  themeOptions = null,
  activeThemeId = null,
  onSelectTheme = null,
  activeThemeName = null,
  onCreateTheme = null,
  onRenameTheme = null,
  onDeleteTheme = null,
  canDeleteActiveTheme = false,
  onClose
}) {
  const [scope, setScope] = useState('global');
  const [appearance, setAppearance] = useState(null);
  const [isLoaded, setIsLoaded] = useState(Boolean(themeOptions));
  const [error, setError] = useState('');
  const [newThemeName, setNewThemeName] = useState('');
  const [renameThemeName, setRenameThemeName] = useState(activeThemeName ?? '');

  useEffect(() => {
    setRenameThemeName(activeThemeName ?? '');
  }, [activeThemeName, activeThemeId]);

  const hasLiveTheme = Array.isArray(themeOptions);
  // Stored global values for generic (registry-rendered) entries. Theme and
  // energy have live bindings; everything else reads/writes through this.
  const [values, setValues] = useState({});

  // Language servers (ADR-005 Slice 7): self-loaded like global prefs —
  // inventory is machine state, not workspace state, so the launcher and
  // in-app callers both get it.
  const [servers, setServers] = useState(null);
  const [serversError, setServersError] = useState('');
  const [serverNotice, setServerNotice] = useState('');
  const [serverBusy, setServerBusy] = useState(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(null);

  const reloadServers = async () => {
    try {
      setServers(await lspServerInventory());
    } catch (loadError) {
      setServersError(toErrorMessage(loadError, 'Failed to load language servers.'));
    }
  };

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const payload = await lspServerInventory();
        if (isMounted) setServers(payload);
      } catch (loadError) {
        if (isMounted) {
          setServersError(toErrorMessage(loadError, 'Failed to load language servers.'));
        }
      }
    })();
    return () => { isMounted = false; };
  }, []);

  const runServerAction = async (languageId, action, buildNotice) => {
    setServersError('');
    setServerNotice('');
    setServerBusy(languageId);
    try {
      const result = await action();
      setServerNotice(buildNotice(result));
      await reloadServers();
    } catch (actionError) {
      setServersError(toErrorMessage(actionError, 'Language server action failed.'));
    } finally {
      setServerBusy(null);
      setConfirmingUninstall(null);
    }
  };

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const prefs = await prefsLoadGlobal();
        if (!isMounted) return;
        setValues(prefs ?? {});
        // Launcher only: no live workspace theme state exists, so the stored
        // appearance populates the theme select.
        if (!hasLiveTheme) setAppearance(prefs?.[PREF_KEYS.appearance] ?? null);
      } catch (loadError) {
        if (isMounted) setError(toErrorMessage(loadError, 'Failed to load preferences.'));
      } finally {
        if (isMounted) setIsLoaded(true);
      }
    })();
    return () => { isMounted = false; };
  }, [hasLiveTheme]);

  const themeDomain = useMemo(
    () => (hasLiveTheme ? null : createThemeDomain({ appearance })),
    [hasLiveTheme, appearance]
  );
  const resolvedThemeOptions = hasLiveTheme ? themeOptions : themeDomain.selectors.listThemes();
  const resolvedActiveThemeId = hasLiveTheme
    ? activeThemeId
    : themeDomain.selectors.getSettingsSummary().activeThemeId;

  const handleSelectTheme = async (themeId) => {
    setError('');
    if (hasLiveTheme) {
      onSelectTheme?.(themeId);
      return;
    }
    const next = themeDomain.commands.setActiveTheme({ themeId });
    setAppearance(next);
    try {
      await prefsSaveGlobal(PREF_KEYS.appearance, next);
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save theme preference.'));
    }
  };

  const handleSelectGlobalEnergy = async (level) => {
    setError('');
    try {
      await onApplyEnergyLevel?.(level);
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save energy preference.'));
    }
  };

  const handleSelectProjectEnergy = async (levelOrNull) => {
    setError('');
    try {
      await onSetProjectEnergy?.(levelOrNull);
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save project override.'));
    }
  };

  // Generic registry entries (no live binding): local state + write-through.
  const handleSetGeneric = async (entry, value) => {
    setError('');
    setValues((prev) => ({ ...prev, [entry.key]: value }));
    try {
      await prefsSaveGlobal(entry.key, value);
    } catch (saveError) {
      setError(toErrorMessage(saveError, `Failed to save ${entry.label}.`));
    }
  };

  const renderChoices = (entry, current, onSelect) => (
    <div className="prefs-choices" role="group" aria-label={entry.label}>
      {entry.values.map((value) => (
        <button
          key={value}
          type="button"
          className={`launch-toggle ${current === value ? 'is-active' : ''}`}
          disabled={Boolean(entry.comingSoon) || !onSelect}
          aria-pressed={current === value}
          onClick={() => onSelect?.(value)}
        >
          {value.charAt(0).toUpperCase() + value.slice(1)}
        </button>
      ))}
    </div>
  );

  const renderGlobalControl = (entry) => {
    switch (entry.key) {
      case PREF_KEYS.appearance:
        return (
          <select
            className="launch-input prefs-select"
            aria-label="Active theme"
            value={resolvedActiveThemeId ?? ''}
            disabled={!isLoaded}
            onChange={(e) => handleSelectTheme(e.target.value)}
          >
            {resolvedThemeOptions.map((theme) => (
              <option key={theme.id} value={theme.id}>{theme.name}</option>
            ))}
          </select>
        );
      case PREF_KEYS.energyLevel:
        return renderChoices(entry, energyLevel === 'calm' ? 'calm' : 'live', handleSelectGlobalEnergy);
      default: {
        if (entry.type === 'boolean') {
          const current = Boolean(values[entry.key] ?? entry.defaultValue);
          return (
            <button
              type="button"
              role="switch"
              aria-checked={current}
              aria-label={entry.label}
              className={`prefs-switch ${current ? 'is-on' : ''}`}
              disabled={Boolean(entry.comingSoon) || !isLoaded}
              onClick={() => handleSetGeneric(entry, !current)}
            >
              <span className="prefs-switch-thumb" aria-hidden="true" />
            </button>
          );
        }
        if (entry.type === 'text') {
          return (
            <input
              className="launch-input prefs-select"
              aria-label={entry.label}
              value={values[entry.key] ?? entry.defaultValue ?? ''}
              placeholder="System default"
              disabled={!isLoaded}
              onChange={(e) => setValues((prev) => ({ ...prev, [entry.key]: e.target.value }))}
              onBlur={(e) => handleSetGeneric(entry, e.target.value)}
            />
          );
        }
        const current = values[entry.key] ?? entry.defaultValue;
        return renderChoices(entry, current, entry.comingSoon ? null : (v) => handleSetGeneric(entry, v));
      }
    }
  };

  // Split row: text on the left, control on the right. The caption stays
  // always-visible (ADR-019) but no longer claims a full-width line of its
  // own, which is what stretched this panel past the viewport.
  const renderGlobalRows = () => entriesForPlace('preferences.global').map((entry) => (
    <div className="prefs-row is-split" key={entry.key}>
      <div className="prefs-row-text">
        <span className="prefs-label">{entry.label}</span>
        <div className="prefs-caption">{entry.caption}</div>
        {entry.comingSoon && <div className="prefs-coming-soon">{entry.comingSoon}</div>}
      </div>
      <div className="prefs-row-control">{renderGlobalControl(entry)}</div>
    </div>
  ));

  // Library room (ADR-019): definitions live here, surfaces only select.
  // Theme create/rename/delete moved out of the Settings drawer. In-app only —
  // library editing needs the live workspace theme state.
  const hasLibrary = hasLiveTheme && typeof onCreateTheme === 'function';
  const renderLibraryRoom = () => (
    <div className="prefs-row prefs-library">
      <div className="prefs-row-head">
        <span className="prefs-label">Theme library</span>
      </div>
      <div className="prefs-caption">
        Create and manage your themes. Built-in themes can be duplicated but not renamed or deleted.
      </div>
      <div className="prefs-library-line">
        <input
          className="launch-input prefs-library-input"
          value={newThemeName}
          onChange={(e) => setNewThemeName(e.target.value)}
          placeholder={`New theme from ${activeThemeName ?? 'active'}`}
        />
        <button
          className="launch-action"
          type="button"
          disabled={!newThemeName.trim()}
          onClick={() => { onCreateTheme?.(newThemeName); setNewThemeName(''); }}
        >
          Create
        </button>
      </div>
      <div className="prefs-library-line">
        <input
          className="launch-input prefs-library-input"
          value={renameThemeName}
          onChange={(e) => setRenameThemeName(e.target.value)}
          placeholder="Rename active theme"
          disabled={!canDeleteActiveTheme}
        />
        <button
          className="launch-action"
          type="button"
          disabled={!canDeleteActiveTheme || !renameThemeName.trim()}
          onClick={() => onRenameTheme?.(renameThemeName)}
        >
          Rename
        </button>
      </div>
      <div className="prefs-library-line">
        <button
          className="launch-action"
          type="button"
          disabled={!canDeleteActiveTheme}
          onClick={() => onDeleteTheme?.()}
        >
          Delete active theme
        </button>
      </div>
    </div>
  );

  // Language servers room (ADR-005 Slice 7). Receipts + resolver tiers are
  // the truth; actions are gated per row (rowActions) so a button never
  // promises what the backend would refuse. Uninstall confirms inline —
  // second click on the same control — never a modal.
  const renderServerRow = (row) => {
    const actions = rowActions(row);
    const anyBusy = serverBusy !== null;
    const thisBusy = serverBusy === row.languageId;
    const confirming = confirmingUninstall === row.languageId;
    return (
      <div key={row.languageId}>
        <div className="prefs-library-line">
          <span className="prefs-label">{row.name}</span>
          <span className={`prefs-layer-badge ${row.tier === 'managed' ? 'is-override' : ''}`}>
            {tierBadge(row)}
          </span>
          {row.updateAvailable && (
            <span className="prefs-layer-badge is-override">Update available</span>
          )}
          {actions.includes('install') && (
            <button
              className="launch-action"
              type="button"
              disabled={anyBusy}
              onClick={() => runServerAction(
                row.languageId,
                () => lspInstallServer(row.languageId),
                (r) => `${r.server} ${r.version} installed and verified.`
              )}
            >
              {thisBusy ? 'Installing…' : 'Install'}
            </button>
          )}
          {actions.includes('update') && (
            <button
              className="launch-action"
              type="button"
              disabled={anyBusy}
              onClick={() => runServerAction(
                row.languageId,
                () => lspInstallServer(row.languageId),
                (r) => `${r.server} updated to ${r.version} (verified).`
              )}
            >
              {thisBusy ? 'Updating…' : `Update to ${row.registryVersion}`}
            </button>
          )}
          {actions.includes('reverify') && (
            <button
              className="launch-toggle"
              type="button"
              disabled={anyBusy}
              onClick={() => runServerAction(
                row.languageId,
                () => lspReverifyServer(row.languageId),
                (r) => `${row.server}: ${reverifyMessage(r)}`
              )}
            >
              Re-verify
            </button>
          )}
          {actions.includes('uninstall') && (
            <button
              className={`launch-toggle ${confirming ? 'is-active' : ''}`}
              type="button"
              disabled={anyBusy}
              onClick={() => {
                if (!confirming) {
                  setConfirmingUninstall(row.languageId);
                  return;
                }
                runServerAction(
                  row.languageId,
                  () => lspUninstallServer(row.languageId),
                  (r) => uninstallSummary(r)
                );
              }}
            >
              {confirming ? 'Confirm uninstall' : 'Uninstall'}
            </button>
          )}
        </div>
        <div className="prefs-caption">{rowStatusLine(row)}</div>
      </div>
    );
  };

  const renderLanguageServersRoom = () => {
    const groups = groupInventoryRows(servers?.rows);
    const total = formatBytes(servers?.managedTotalBytes);
    return (
      <div className="prefs-row prefs-library">
        <div className="prefs-row-head">
          <span className="prefs-label">Language servers</span>
        </div>
        <div className="prefs-caption">
          Installed language intelligence and what the curated registry can add.
          Managed installs are pinned versions, verified before they touch disk.
          {servers && total ? ` Managed disk usage: ${total}.` : ''}
        </div>
        {!servers && !serversError && <div className="prefs-caption">Loading…</div>}
        {[...groups.installed, ...groups.available].map(renderServerRow)}
        {serverNotice && <div className="prefs-caption">{serverNotice}</div>}
        {serversError && <div className="launch-error">{serversError}</div>}
      </div>
    );
  };

  // Project scope: every row shows which layer supplies its value, and an
  // override always has a one-click way back to the global ground.
  const renderProjectRows = () => entriesForPlace('preferences.project').map((entry) => {
    const isOverridden = entry.key === PREF_KEYS.energyLevel && projectEnergyLevel !== null;
    const effective = entry.key === PREF_KEYS.energyLevel
      ? (projectEnergyLevel ?? (energyLevel === 'calm' ? 'calm' : 'live'))
      : entry.defaultValue;
    return (
      <div className="prefs-row" key={entry.key}>
        <div className="prefs-row-head">
          <span className="prefs-label">{entry.label}</span>
          {renderChoices(entry, effective, (value) => handleSelectProjectEnergy(value))}
        </div>
        <div className="prefs-caption">{entry.caption}</div>
        <div className="prefs-layer-line">
          <span className={`prefs-layer-badge ${isOverridden ? 'is-override' : ''}`}>
            {isOverridden ? 'Overridden here' : 'Inheriting global'}
          </span>
          {isOverridden && (
            <button
              type="button"
              className="launch-toggle prefs-reset"
              onClick={() => handleSelectProjectEnergy(null)}
            >
              Reset to global
            </button>
          )}
        </div>
      </div>
    );
  });

  return (
    <div
      className={`launch-modal-shell ${projectContext ? 'prefs-shell-in-app' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Preferences"
    >
      <div className="launch-modal prefs-modal">
        <div className="launch-modal-title">Preferences</div>

        {projectContext ? (
          <div className="prefs-scope-tabs" role="tablist" aria-label="Preference scope">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'global'}
              className={`launch-toggle ${scope === 'global' ? 'is-active' : ''}`}
              onClick={() => setScope('global')}
            >
              Global
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'project'}
              className={`launch-toggle ${scope === 'project' ? 'is-active' : ''}`}
              onClick={() => setScope('project')}
            >
              This project
            </button>
          </div>
        ) : null}

        <div className="prefs-scope-note">
          {scope === 'project' && projectContext
            ? `${projectContext.name} — refinements for this project; anything not overridden follows global.`
            : 'Global — how Litria behaves for you, across all projects.'}
        </div>

        {/* Scroll the settings, not the dialog: the title and Done button stay
            put however many preferences the registry grows. */}
        <div className="prefs-body">
          {scope === 'project' && projectContext ? renderProjectRows() : (
            <>
              {renderGlobalRows()}
              {hasLibrary && renderLibraryRoom()}
              {renderLanguageServersRoom()}
            </>
          )}
        </div>

        {error && <div className="launch-error">{error}</div>}

        <div className="prefs-actions">
          <button className="launch-action" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Tauri command rejections are plain {category, code, message} objects, not
// Error instances — duck-type so the real message survives.
function toErrorMessage(error, fallback) {
  return typeof error?.message === 'string' && error.message ? error.message : fallback;
}

export default PreferencesPanel;
