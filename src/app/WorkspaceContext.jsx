import { createContext, useContext, useMemo } from 'react';

const WorkspaceContext = createContext(null);

export function WorkspaceProvider({
  children,
  pieceDomain,
  selectionDomain,
  pieces,
  selectedIds,
  selectedCount,
  modeDomain = null,
  interactionMode = 'default',
  activeSubMode = null
}) {
  const value = useMemo(() => ({
    pieceDomain,
    selectionDomain,
    pieces,
    selectedIds,
    selectedCount,
    modeDomain,
    interactionMode,
    activeSubMode
  }), [pieceDomain, selectionDomain, pieces, selectedIds, selectedCount, modeDomain, interactionMode, activeSubMode]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider.');
  }
  return context;
}

