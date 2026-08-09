import { useCallback, useEffect, useRef, useState } from 'react';

export default function ProjectSwitcher({
  currentProjectName,
  currentProjectRootPath,
  recents,
  onOpen,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const hasProject = Boolean(currentProjectName);
  const canOpen = hasProject && Array.isArray(recents) && recents.length > 0;

  const toggle = useCallback(() => {
    if (!canOpen) return;
    setIsOpen((prev) => !prev);
  }, [canOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const containerClass = [
    'project-switcher',
    isOpen ? 'is-open' : '',
    hasProject ? '' : 'is-empty',
  ].filter(Boolean).join(' ');

  return (
    <div className={containerClass} ref={containerRef}>
      <button
        className="project-switcher-trigger"
        onClick={toggle}
        disabled={!canOpen}
        title={hasProject ? 'Switch project' : undefined}
      >
        <span className="project-switcher-current">
          {hasProject ? currentProjectName : 'Select A Project…'}
        </span>
        <span className="project-switcher-chevron" aria-hidden="true">&#9662;</span>
      </button>
      {isOpen && (
        <div className="project-switcher-dropdown">
          {recents.map((entry) => {
            const isCurrent = currentProjectRootPath
              ? entry.rootPath === currentProjectRootPath
              : entry.name === currentProjectName;
            return (
              <button
                key={entry.rootPath}
                className={`project-switcher-item${isCurrent ? ' is-current' : ''}`}
                onClick={() => {
                  if (isCurrent) return;
                  onOpen({ rootPath: entry.rootPath });
                  setIsOpen(false);
                }}
                disabled={isCurrent}
                title={entry.rootPath}
              >
                <span className="project-switcher-item-name">
                  {isCurrent && (
                    <span className="project-switcher-item-check" aria-hidden="true">&#10003; </span>
                  )}
                  {entry.name}
                </span>
                <span className="project-switcher-item-path">{entry.rootPath}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
