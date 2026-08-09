import { createContext, useContext, useMemo, useState } from 'react';

const TopDrawerContext = createContext(null);

function TopDrawerProvider({ drawers, children }) {
  const [drawerState, setDrawerState] = useState({
    activeId: null,
    isOpen: false
  });

  const openDrawer = (id) => {
    if (!id) return;
    setDrawerState({ activeId: id, isOpen: true });
  };

  const closeDrawer = () => {
    setDrawerState((prev) => ({ ...prev, isOpen: false }));
  };

  const toggleDrawer = (id) => {
    if (!id) return;
    setDrawerState((prev) => {
      if (prev.activeId === id && prev.isOpen) {
        return { ...prev, isOpen: false };
      }
      return { activeId: id, isOpen: true };
    });
  };

  const value = useMemo(
    () => ({
      drawers,
      activeId: drawerState.activeId,
      isOpen: drawerState.isOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer
    }),
    [drawers, drawerState.activeId, drawerState.isOpen]
  );

  return <TopDrawerContext.Provider value={value}>{children}</TopDrawerContext.Provider>;
}

function useTopDrawers() {
  const ctx = useContext(TopDrawerContext);
  if (!ctx) {
    throw new Error('useTopDrawers must be used within TopDrawerProvider.');
  }
  return ctx;
}

export { TopDrawerProvider, useTopDrawers };
