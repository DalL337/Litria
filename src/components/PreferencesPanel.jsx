import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  FilePlus,
  FolderOpen,
  Globe,
  Info,
  Languages,
  Layers,
  Palette,
  Search,
  SlidersHorizontal
} from 'lucide-react';
import { entriesByRoom, entriesForPlace, PREF_KEYS } from '../preferences/registry.js';
import { filterRooms, highlight, textMatches } from '../preferences/search.js';
import { ROVING_KEYS, rovingTarget } from '../scaffold/wizardNavigation';
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
 * PreferencesPanel — the Preferences surface (ADR-019), v2 chrome
 * (brief-preferences-panel-v2.md): the wizard's bounded modal with a
 * pinned header and footer, scope pills, a rooms rail that tracks the
 * room in view, and rows rendered from `entriesByRoom` — never a
 * hand-placed list.
 *
 * Two callers, one renderer:
 * - Launcher (`projectContext` null): global scope only — no project is open,
 *   so there is nothing to override. Loads appearance itself. The project
 *   pill still renders, disabled, with its caption: the concept is
 *   discoverable before it is usable.
 * - In-app (File → Preferences…): Global + This project scope. Receives the
 *   LIVE theme state as props (self-loading would desync the open
 *   workspace) and the project energy override + setters.
 *
 * Rooms: the registry's preference rooms first, then Themes (the library —
 * definitions, not preferences) and Language servers (machine state), which
 * the panel renders itself. Captions are always visible, never tooltips.
 */

const ROOM_ICONS = {
  appearance: Palette,
  projectCreation: FilePlus,
  behavior: SlidersHorizontal,
  themes: Layers,
  servers: Languages
};

const THEMES_ROOM = {
  id: 'themes',
  label: 'Themes',
  description: 'Your theme library — definitions live here; other surfaces only pick from them.'
};

const SERVERS_ROOM = {
  id: 'servers',
  label: 'Language servers',
  description: 'Installed language intelligence and what the curated registry can add. Managed installs are pinned versions, verified before they touch disk.'
};

const SAVED_IDLE = 'Changes save as you go';

function tierClass(row) {
  if (row.updateAvailable) return 'is-update';
  switch (row?.tier) {
    case 'managed': return 'is-managed';
    case 'global': return 'is-path';
    case 'bundled': return 'is-bundled';
    default: return '';
  }
}

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
  // Search (slice 4): the exhaustive home is searchable. Matches by label
  // and caption; rooms stay in the rail (dimmed) so the panel never jumps.
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const hasQuery = query.trim() !== '';
  const [appearance, setAppearance] = useState(null);
  const [isLoaded, setIsLoaded] = useState(Boolean(themeOptions));
  const [error, setError] = useState('');
  const [newThemeName, setNewThemeName] = useState('');
  const [renameThemeName, setRenameThemeName] = useState(activeThemeName ?? '');

  // Footer feedback for the write-through model: idle text, then a short
  // "Saved …" after every successful write.
  const [savedNote, setSavedNote] = useState(SAVED_IDLE);
  const savedTimer = useRef(null);
  const flashSaved = (message) => {
    setSavedNote(message);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedNote(SAVED_IDLE), 1400);
  };
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  // Rooms rail: the body is the scroller; each room section registers its
  // element so scrolling can track the room in view and the rail can jump.
  const bodyRef = useRef(null);
  const titleRef = useRef(null);
  const sectionRefs = useRef({});
  const [activeRoom, setActiveRoom] = useState(null);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

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
      flashSaved('Saved theme');
      return;
    }
    const next = themeDomain.commands.setActiveTheme({ themeId });
    setAppearance(next);
    try {
      await prefsSaveGlobal(PREF_KEYS.appearance, next);
      flashSaved('Saved theme');
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save theme preference.'));
    }
  };

  const handleSelectGlobalEnergy = async (level) => {
    setError('');
    try {
      await onApplyEnergyLevel?.(level);
      flashSaved('Saved energy');
    } catch (saveError) {
      setError(toErrorMessage(saveError, 'Failed to save energy preference.'));
    }
  };

  const handleSelectProjectEnergy = async (levelOrNull) => {
    setError('');
    try {
      await onSetProjectEnergy?.(levelOrNull);
      flashSaved(levelOrNull === null ? 'Back to global' : `Saved for ${projectContext?.name ?? 'this project'}`);
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
      flashSaved(`Saved ${entry.label.toLowerCase()}`);
    } catch (saveError) {
      setError(toErrorMessage(saveError, `Failed to save ${entry.label}.`));
    }
  };

  // -- Scope + rooms --
  const inProject = scope === 'project' && Boolean(projectContext);
  const place = inProject ? 'preferences.project' : 'preferences.global';
  const registryRooms = filterRooms(entriesByRoom(place), query);
  const hasLibrary = hasLiveTheme && typeof onCreateTheme === 'function';
  const allServerRows = servers?.rows ?? [];
  const serverRows = allServerRows.filter((row) => textMatches(`${row.name} ${rowStatusLine(row)}`, query));
  const themeRowCount = hasLibrary ? 2 : 0;
  const themesMatch = !hasQuery || textMatches('themes theme library new theme active theme rename delete', query);
  const extraRooms = inProject
    ? []
    : [
      { ...THEMES_ROOM, count: themesMatch ? themeRowCount : 0, total: themeRowCount },
      { ...SERVERS_ROOM, count: serverRows.length, total: allServerRows.length }
    ];
  const railRooms = [
    ...registryRooms.map((room) => ({ id: room.id, label: room.label, count: room.entries.length, total: room.total })),
    ...extraRooms
  ];
  const settingCount = entriesForPlace(place).length;
  const matchCount = railRooms.reduce((n, room) => n + room.count, 0);
  const totalCount = railRooms.reduce((n, room) => n + room.total, 0);
  const globalOnlyCount = entriesForPlace('preferences.global').length - entriesForPlace('preferences.project').length;
  const currentRoom = activeRoom && railRooms.some((r) => r.id === activeRoom) ? activeRoom : railRooms[0]?.id;

  const switchScope = (next) => {
    if (next === scope) return;
    setScope(next);
    setActiveRoom(null);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const jumpToRoom = (roomId) => {
    const body = bodyRef.current;
    const section = sectionRefs.current[roomId];
    if (body && section) body.scrollTo({ top: Math.max(0, section.offsetTop - 8), behavior: 'smooth' });
    setActiveRoom(roomId);
  };

  const handleBodyScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const threshold = body.scrollTop + 40;
    let inView = null;
    for (const room of railRooms) {
      const section = sectionRefs.current[room.id];
      if (section && section.offsetTop <= threshold) inView = room.id;
    }
    if (inView && inView !== activeRoom) setActiveRoom(inView);
  };

  // Keyboard model (slice 4): Escape clears a search, backs out a pending
  // uninstall confirm, then closes; "/" and Ctrl/Cmd+F focus search; arrows
  // rove inside a pill group or the scope tabs like native radios.
  const focusSearch = (select = false) => {
    const input = searchRef.current;
    if (!input) return;
    input.focus();
    if (select) input.select();
  };
  const handleKeyDown = (e) => {
    const inTextField = e.target.closest('input, select, textarea');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasQuery && e.target === searchRef.current) {
        setQuery('');
        return;
      }
      if (confirmingUninstall) {
        setConfirmingUninstall(null);
        return;
      }
      onClose();
      return;
    }
    if (e.key === '/' && !inTextField) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      focusSearch(true);
      return;
    }
    const delta = ROVING_KEYS[e.key];
    if (delta === undefined || inTextField) return;
    const group = e.target.closest('[role="radiogroup"], [role="tablist"]');
    const current = e.target.closest('button');
    if (!group || !current || !group.contains(current)) return;
    const options = Array.from(group.querySelectorAll('button:not(:disabled)'));
    const next = rovingTarget(options.indexOf(current), options.length, delta);
    if (next === null) return;
    e.preventDefault();
    // Moving IS choosing, for pills and tabs alike.
    options[next].click();
    options[next].focus();
  };

  // Search hits render as <mark>; everything else passes through.
  const renderHighlighted = (text) => highlight(text, query).map((segment, i) => (
    segment.hit ? <mark key={i} className="pf-mark">{segment.text}</mark> : <span key={i}>{segment.text}</span>
  ));

  // -- Renderers --
  const renderChoices = (entry, current, onSelect) => (
    <div className="pf-pills" role="radiogroup" aria-label={entry.label}>
      {entry.values.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          className="pf-pill"
          disabled={Boolean(entry.comingSoon) || !onSelect}
          aria-checked={current === value}
          onClick={() => onSelect?.(value)}
        >
          {value.charAt(0).toUpperCase() + value.slice(1).replace('-', ' ')}
        </button>
      ))}
    </div>
  );

  const renderGlobalControl = (entry) => {
    switch (entry.key) {
      case PREF_KEYS.appearance:
        return (
          <select
            className="pf-select"
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
              className="pf-switch"
              disabled={Boolean(entry.comingSoon) || !isLoaded}
              onClick={() => handleSetGeneric(entry, !current)}
            >
              <span className="pf-switch-thumb" aria-hidden="true" />
            </button>
          );
        }
        if (entry.type === 'text') {
          return (
            <input
              className="pf-input"
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

  const renderRow = (entry, control, layer = null) => (
    <div className="pf-row" key={entry.key}>
      <div className="pf-row-text">
        <span className="pf-row-label">{renderHighlighted(entry.label)}</span>
        <span className="pf-row-caption">{renderHighlighted(entry.caption)}</span>
        {entry.comingSoon && <span className="pf-row-soon">{entry.comingSoon}</span>}
        {layer}
      </div>
      <div className="pf-row-ctl">{control}</div>
    </div>
  );

  // Project scope: every row shows which layer supplies its value, and an
  // override always has a one-click way back to the global ground. Only
  // energy has a live per-project binding today; other overridable entries
  // render disabled and say so — they used to write the ENERGY override.
  const renderProjectRow = (entry) => {
    const isEnergy = entry.key === PREF_KEYS.energyLevel;
    const isOverridden = isEnergy && projectEnergyLevel !== null;
    const effective = isEnergy
      ? (projectEnergyLevel ?? (energyLevel === 'calm' ? 'calm' : 'live'))
      : (values[entry.key] ?? entry.defaultValue);
    const layer = (
      <div className="pf-row-layer">
        <span className={`pf-layer ${isOverridden ? 'is-override' : ''}`}>
          {isOverridden ? 'Overridden here' : 'Inheriting global'}
        </span>
        {isOverridden && (
          <button type="button" className="pf-link" onClick={() => handleSelectProjectEnergy(null)}>
            Reset to global
          </button>
        )}
        {!isEnergy && (
          <span className="pf-row-caption">Per-project override for this setting is not wired yet — follows Global.</span>
        )}
      </div>
    );
    return renderRow(entry, renderChoices(entry, effective, isEnergy ? handleSelectProjectEnergy : null), layer);
  };

  const renderRoom = (room, children) => {
    const Icon = ROOM_ICONS[room.id];
    return (
      <section
        key={room.id}
        className="pf-room"
        id={`pf-room-${room.id}`}
        aria-labelledby={`pf-room-${room.id}-title`}
        ref={(el) => { sectionRefs.current[room.id] = el; }}
      >
        <div className="pf-room-head">
          {Icon && <Icon size={13} aria-hidden="true" style={{ color: 'var(--cm-indigo-light)' }} />}
          <h3 id={`pf-room-${room.id}-title`}>{room.label}</h3>
        </div>
        <div className="pf-room-desc">{room.description}</div>
        {children}
      </section>
    );
  };

  // Themes room (ADR-019 Library): definitions live here, surfaces only
  // select. In-app only — library editing needs the live workspace theme
  // state. The launcher says where it lives instead of hiding the room.
  const renderThemesRoom = () => renderRoom(THEMES_ROOM, !themesMatch ? (
    <div className="pf-room-empty">no matches</div>
  ) : hasLibrary ? (
    <>
      <div className="pf-row">
        <div className="pf-row-text">
          <span className="pf-row-label">New theme</span>
          <span className="pf-row-caption">
            Duplicate the active theme ({activeThemeName ?? 'active'}) under a new name. Built-in themes can be duplicated but not renamed or deleted.
          </span>
        </div>
        <div className="pf-row-ctl pf-lib-line">
          <input
            className="pf-input"
            value={newThemeName}
            onChange={(e) => setNewThemeName(e.target.value)}
            placeholder="Theme name"
            aria-label="New theme name"
          />
          <button
            className="pf-btn is-small"
            type="button"
            disabled={!newThemeName.trim()}
            onClick={() => { onCreateTheme?.(newThemeName); setNewThemeName(''); flashSaved('Theme created'); }}
          >
            Create
          </button>
        </div>
      </div>
      <div className="pf-row">
        <div className="pf-row-text">
          <span className="pf-row-label">Active theme</span>
          <span className="pf-row-caption">
            {canDeleteActiveTheme
              ? `${activeThemeName ?? 'This theme'} is yours — rename or delete it here.`
              : `${activeThemeName ?? 'This theme'} is built in and cannot be renamed or deleted.`}
          </span>
        </div>
        <div className="pf-row-ctl pf-lib-line">
          <input
            className="pf-input"
            value={renameThemeName}
            onChange={(e) => setRenameThemeName(e.target.value)}
            placeholder="Rename"
            aria-label="Rename active theme"
            disabled={!canDeleteActiveTheme}
          />
          <button
            className="pf-btn is-small"
            type="button"
            disabled={!canDeleteActiveTheme || !renameThemeName.trim()}
            onClick={() => { onRenameTheme?.(renameThemeName); flashSaved('Theme renamed'); }}
          >
            Rename
          </button>
          <button
            className="pf-btn is-small"
            type="button"
            disabled={!canDeleteActiveTheme}
            onClick={() => { onDeleteTheme?.(); flashSaved('Theme deleted'); }}
          >
            Delete
          </button>
        </div>
      </div>
    </>
  ) : (
    <div className="pf-note">
      <Info size={14} aria-hidden="true" />
      <span>
        The theme library is managed inside a workspace — open a project, then File ▸ Preferences…
        Picking the active theme stays here, under Appearance.
      </span>
    </div>
  ));

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
      <div key={row.languageId} className="pf-srv">
        <div>
          <div className="pf-srv-head">
            <span className="pf-srv-name">{renderHighlighted(row.name)}</span>
            <span className={`pf-tier ${tierClass(row)}`}>{tierBadge(row)}</span>
            {row.updateAvailable && <span className="pf-tier is-update">Update available</span>}
          </div>
          <div className="pf-srv-status">{renderHighlighted(rowStatusLine(row))}</div>
        </div>
        <div className="pf-srv-actions">
          {actions.includes('install') && (
            <button
              className="pf-btn is-small is-primary"
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
              className="pf-btn is-small is-primary"
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
              className="pf-pill"
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
              className="pf-pill is-danger"
              type="button"
              aria-pressed={confirming}
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
      </div>
    );
  };

  const renderServersRoom = () => {
    const groups = groupInventoryRows(serverRows);
    const total = formatBytes(servers?.managedTotalBytes);
    return renderRoom(SERVERS_ROOM, (
      <>
        {!servers && !serversError && <div className="pf-caption-line">Loading…</div>}
        {hasQuery && servers && serverRows.length === 0 && <div className="pf-room-empty">no matches</div>}
        {[...groups.installed, ...groups.available].map(renderServerRow)}
        {servers && total ? <div className="pf-caption-line">Managed disk usage: {total}.</div> : null}
        {serverNotice && <div className="pf-caption-line">{serverNotice}</div>}
        {serversError && <div className="pf-error" style={{ padding: 0 }}>{serversError}</div>}
      </>
    ));
  };

  const scopeNote = inProject
    ? `Refinements for ${projectContext.name}. Anything not overridden follows Global.`
    : projectContext
      ? 'How Litria behaves for you, across all projects.'
      : 'Open a project to set per-project overrides.';

  return (
    <div
      className={`pf-overlay ${projectContext ? 'is-in-app' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pf-title"
    >
      <div className="pf-modal" onKeyDown={handleKeyDown}>
        {/* ---- Header: title + scope pills (pinned) ---- */}
        <div className="pf-header">
          <div className="pf-title-row">
            <h2 className="pf-title" id="pf-title" ref={titleRef} tabIndex={-1}>Preferences</h2>
            <span className="pf-title-sub">
              {hasQuery ? `${matchCount} of ${totalCount} match \u201C${query.trim()}\u201D` : `${settingCount} settings`}
            </span>
          </div>
          <div className="pf-scope-row" role="tablist" aria-label="Preference scope">
            <button
              type="button"
              role="tab"
              className="pf-scope"
              aria-selected={!inProject}
              onClick={() => switchScope('global')}
            >
              <span className="pf-scope-dot" aria-hidden="true">
                {inProject ? <Globe size={11} /> : <Check size={11} strokeWidth={2.5} />}
              </span>
              Global
            </button>
            <button
              type="button"
              role="tab"
              className="pf-scope"
              aria-selected={inProject}
              disabled={!projectContext}
              onClick={() => switchScope('project')}
            >
              <span className="pf-scope-dot" aria-hidden="true">
                {inProject ? <Check size={11} strokeWidth={2.5} /> : <FolderOpen size={11} />}
              </span>
              This project
              {projectContext && <span className="pf-scope-name">· {projectContext.name}</span>}
            </button>
            <span className="pf-scope-note">{scopeNote}</span>
            <label className="pf-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                className="pf-search-input"
                type="search"
                value={query}
                placeholder="Find a setting\u2026"
                aria-label="Find a setting"
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd className="pf-key pf-search-key" aria-hidden="true">/</kbd>
            </label>
          </div>
        </div>

        {/* ---- Body: rooms rail + the one scrolling region ---- */}
        <div className="pf-body-wrap">
          <nav className="pf-rail" aria-label="Rooms">
            <div className="pf-rail-label">Rooms</div>
            {railRooms.map((room) => {
              const Icon = ROOM_ICONS[room.id];
              return (
                <button
                  key={room.id}
                  type="button"
                  className={`pf-rail-item${hasQuery && room.count === 0 ? ' is-empty' : ''}`}
                  aria-current={currentRoom === room.id}
                  onClick={() => jumpToRoom(room.id)}
                >
                  {Icon && <Icon size={14} aria-hidden="true" />}
                  {room.label}
                  <span className="pf-rail-n">{hasQuery ? `${room.count}/${room.total}` : room.total}</span>
                </button>
              );
            })}
          </nav>
          <div className="pf-body" ref={bodyRef} onScroll={handleBodyScroll}>
            {registryRooms.map((room) => renderRoom(
              room,
              room.entries.length === 0
                ? <div className="pf-room-empty">no matches</div>
                : room.entries.map((entry) => (inProject
                  ? renderProjectRow(entry)
                  : renderRow(entry, renderGlobalControl(entry))))
            ))}
            {!inProject && renderThemesRoom()}
            {!inProject && renderServersRoom()}
            {inProject && globalOnlyCount > 0 && (
              <div className="pf-note">
                <Info size={14} aria-hidden="true" />
                <span>
                  {globalOnlyCount} more {globalOnlyCount === 1 ? 'setting is' : 'settings are'} global only — they apply to every project.{' '}
                  <button type="button" className="pf-link" onClick={() => switchScope('global')}>Switch to Global</button>
                </span>
              </div>
            )}
          </div>
        </div>

        {error && <div className="pf-error">{error}</div>}

        {/* ---- Footer (pinned): write-through status + Done ---- */}
        <div className="pf-footer">
          <div className="pf-saved" aria-live="polite">
            <span className="pf-saved-led" aria-hidden="true" />
            <span>{savedNote}</span>
          </div>
          <button className="pf-btn is-primary" type="button" onClick={onClose} aria-keyshortcuts="Escape">
            Done<kbd className="pf-key">Esc</kbd>
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
