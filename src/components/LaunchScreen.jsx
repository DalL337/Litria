import { useState } from 'react';
import { X } from 'lucide-react';
import { usePlatformConfig } from '../platform/usePlatformConfig';
import { getLastProjectDir, rememberProjectDir } from '../utils/lastProjectDir';
import NewProjectWizard from './NewProjectWizard';
import PreferencesPanel from './PreferencesPanel';
import { prefsLoadGlobal } from '../preferences/preferencesStore.js';
import { findEntry, PREF_KEYS } from '../preferences/registry.js';
import LauncherRecentsDrawer from './LauncherRecentsDrawer';
import CrashNoticeBanner from '../crash/CrashNoticeBanner';

function LaunchScreen({
  onCreateProject,
  onOpenProject,
  onOpenFile,
  onNewFile,
  onExit,
  energyLevel,
  onApplyEnergyLevel,
  recents = [],
  onPinProject,
  onRemoveProject,
  crashNotices = [],
  onCrashNoticesDismissed,
  buildLogDomain = null,
  buildLogActions = null,
}) {
  const { placeholderPath, placeholderNewProjectPath } = usePlatformConfig();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isOpenExistingOpen, setIsOpenExistingOpen] = useState(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  // Seed-type preferences read at wizard open (ADR-019 Slice 4): the wizard
  // picks from the user's ground; the project captures the values at creation.
  const [seedPrefs, setSeedPrefs] = useState(null);

  const handleOpenWizard = async () => {
    try {
      setSeedPrefs(await prefsLoadGlobal());
    } catch {
      setSeedPrefs(null);
    }
    setIsCreateOpen(true);
  };
  const [existingRootPath, setExistingRootPath] = useState('');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleWizardDone = async ({ name, rootPath, workspaceStyle, theme, energyLevel: chosenEnergyLevel, blankFiles = null, stack = null, pythonEnv = null, npmScripts = null }) => {
    setIsCreating(true);
    setError('');
    try {
      // Apply the previewed energy level (global preference) BEFORE opening the
      // project — opening re-reads preferences, so this write must land first.
      if (chosenEnergyLevel && typeof onApplyEnergyLevel === 'function') {
        await onApplyEnergyLevel(chosenEnergyLevel);
      }
      // blankFiles: files the Blank/Python templates generated — seeded onto
      // the canvas as the project's first pieces. stack/pythonEnv (ADR-020):
      // language+archetype for the DB row, floor for litria.toml
      // [environment], interpreter for the workspace binding.
      await onCreateProject({ name, rootPath, scaffoldPlan: null, workspaceStyle, theme, seedFiles: blankFiles, stack, pythonEnv, npmScripts });
      setIsCreateOpen(false);
    } catch (createError) {
      // Tauri command rejections are plain {category, code, message} objects,
      // not Error instances — duck-type so the real message survives.
      const message = typeof createError?.message === 'string' && createError.message
        ? createError.message
        : 'Failed to create project.';
      setError(message);
      // Re-throw: while the wizard is open our error div is hidden
      // (`error && !isCreateOpen`), so the wizard's own catch must render it
      // and re-enable its controls.
      throw createError instanceof Error ? createError : new Error(message);
    } finally {
      setIsCreating(false);
    }
  };

  const pickProjectFolder = async (title) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title,
        defaultPath: getLastProjectDir(),
      });
      if (Array.isArray(selected)) {
        return typeof selected[0] === 'string' ? selected[0] : '';
      }
      return typeof selected === 'string' ? selected : '';
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Folder picker unavailable: ${error.message}`
          : 'Folder picker unavailable.'
      );
    }
  };

  const handlePickExistingPath = async () => {
    if (isCreating) return;
    try {
      const selected = await pickProjectFolder('Select Existing Project Folder');
      if (!selected) return;
      setExistingRootPath(selected);
      // Picked path is a project folder — remember its parent so the next open
      // lands on the folder that lists your projects, not inside one.
      rememberProjectDir(selected, { isContainer: false });
      setError('');
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : 'Folder picker unavailable.');
    }
  };

  const handleOpenExisting = async () => {
    const trimmedPath = existingRootPath.trim();
    if (!trimmedPath) {
      setError('Project path is required.');
      return;
    }
    if (typeof onOpenProject !== 'function') {
      setError('Open existing project is unavailable.');
      return;
    }
    setIsCreating(true);
    setError('');
    try {
      await onOpenProject({ rootPath: trimmedPath });
      setIsOpenExistingOpen(false);
      setExistingRootPath('');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Failed to open project.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenRecent = async (rootPath) => {
    if (isCreating) return;
    if (typeof onOpenProject !== 'function') {
      setError('Open existing project is unavailable.');
      return;
    }
    setIsCreating(true);
    setError('');
    try {
      await onOpenProject({ rootPath });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Failed to open project.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleNewFile = () => {
    if (typeof onNewFile !== 'function') {
      setError('New file is unavailable.');
      return;
    }
    setError('');
    onNewFile();
  };

  const handleOpenFile = async () => {
    if (typeof onOpenFile !== 'function') {
      setError('Open file is unavailable.');
      return;
    }
    setIsCreating(true);
    setError('');
    try {
      // ADR-022: onOpenFile opens the OS picker in Rust and reads the picked
      // file. A cancel is a no-op; a read error throws.
      await onOpenFile();
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Failed to open file.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="launch-root">
      <LauncherRecentsDrawer
        recents={recents}
        onOpenRecent={handleOpenRecent}
        onPinProject={onPinProject}
        onRemoveProject={onRemoveProject}
        disabled={isCreating}
      />
      <div className="launch-panel">
        <div className="launch-panel-header">
          <div className="launch-title">Litria</div>
          {onExit && (
            <button
              className="launch-close-button"
              type="button"
              onClick={onExit}
              aria-label="Exit Litria"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="launch-subtitle">Start a workspace</div>

        <CrashNoticeBanner notices={crashNotices} onDismissed={onCrashNoticesDismissed} />

        <div className="launch-group">
          <div className="launch-group-title">New</div>
          <button className="launch-action is-primary" type="button" onClick={handleOpenWizard}>
            Project
          </button>
          <button className="launch-action" type="button" onClick={handleNewFile} disabled={isCreating}>
            File
          </button>
        </div>

        <div className="launch-group">
          <div className="launch-group-title">Open</div>
          <button className="launch-action" type="button" onClick={() => setIsOpenExistingOpen(true)}>
            Existing Project
          </button>
          <button className="launch-action" type="button" onClick={handleOpenFile} disabled={isCreating}>
            File
          </button>
        </div>

        <div className="launch-group">
          <div className="launch-group-title">Settings</div>
          <button className="launch-action" type="button" onClick={() => setIsPreferencesOpen(true)}>
            Preferences
          </button>
        </div>
        {error && !isCreateOpen && !isOpenExistingOpen && <div className="launch-error">{error}</div>}
      </div>

      {isPreferencesOpen && (
        <PreferencesPanel
          energyLevel={energyLevel}
          onApplyEnergyLevel={onApplyEnergyLevel}
          onClose={() => setIsPreferencesOpen(false)}
        />
      )}
      {isCreateOpen && (
        <NewProjectWizard
          onDone={handleWizardDone}
          onCancel={() => { setIsCreateOpen(false); setError(''); }}
          defaultFolder={
            (typeof seedPrefs?.[PREF_KEYS.defaultProjectLocation] === 'string' && seedPrefs[PREF_KEYS.defaultProjectLocation].trim())
              ? seedPrefs[PREF_KEYS.defaultProjectLocation]
              : placeholderNewProjectPath
          }
          initialEnergyLevel={energyLevel}
          initialTheme={seedPrefs?.[PREF_KEYS.defaultBaseTheme]}
          buildLogDomain={buildLogDomain}
          buildLogActions={buildLogActions}
          // Read from the same seed snapshot as the other wizard defaults;
          // the fallback is the registry default, not a local copy of it.
          tracePause={seedPrefs?.[PREF_KEYS.buildTracePause] ?? findEntry(PREF_KEYS.buildTracePause).defaultValue}
          autoSendLogs={seedPrefs?.[PREF_KEYS.buildLogAutoSend] === true}
        />
      )}
      {isOpenExistingOpen && (
        <div className="launch-modal-shell" role="dialog" aria-modal="true">
          <div className="launch-modal">
            <div className="launch-modal-title">Open Existing Project</div>
            <label className="launch-label" htmlFor="launch-existing-project-path">Project Path</label>
            <div className="launch-picker-row">
              <input
                id="launch-existing-project-path"
                className="launch-input"
                value={existingRootPath}
                onChange={(event) => setExistingRootPath(event.target.value)}
                placeholder={placeholderPath}
                autoFocus
              />
              <button
                className="launch-action launch-picker-button"
                type="button"
                onClick={handlePickExistingPath}
                disabled={isCreating}
              >
                Browse
              </button>
            </div>
            {error && <div className="launch-error">{error}</div>}
            <div className="launch-modal-actions">
              <button
                className="launch-action"
                type="button"
                onClick={() => {
                  setIsOpenExistingOpen(false);
                  setError('');
                }}
                disabled={isCreating}
              >
                Cancel
              </button>
              <button
                className="launch-action is-primary"
                type="button"
                onClick={handleOpenExisting}
                disabled={isCreating}
              >
                {isCreating ? 'Opening...' : 'Open Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LaunchScreen;
