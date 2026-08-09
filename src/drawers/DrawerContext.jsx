import { createContext, useContext, useMemo, useState } from 'react';

const DrawerContext = createContext(null);

function DrawerProvider({ drawers, initialActiveId, initialOpen = false, children }) {
  const fallbackId = drawers && drawers.length > 0 ? drawers[0].id : null;
  const [drawerState, setDrawerState] = useState({
    activeId: initialActiveId || fallbackId,
    isOpen: initialOpen
  });

  const openDrawer = (id) => {
    if (!id) return;
    setDrawerState(prev => ({
      ...prev,
      activeId: id,
      isOpen: true
    }));
  };

  const closeDrawer = () => {
    setDrawerState(prev => ({
      ...prev,
      isOpen: false,
      activeId: null
    }));
  };

  const toggleDrawer = (id) => {
    if (!id) return;
    setDrawerState(prev => {
      if (prev.activeId === id && prev.isOpen) {
        return { ...prev, isOpen: false, activeId: null };
      }
      return { ...prev, activeId: id, isOpen: true };
    });
  };

  const value = useMemo(() => ({
    drawers,
    activeId: drawerState.activeId,
    isOpen: drawerState.isOpen,
    openDrawer,
    closeDrawer,
    toggleDrawer
  }), [drawers, drawerState.activeId, drawerState.isOpen]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
    </DrawerContext.Provider>
  );
}

function useDrawers() {
  const ctx = useContext(DrawerContext);
  if (!ctx) {
    throw new Error('useDrawers must be used within DrawerProvider.');
  }
  return ctx;
}

export { DrawerProvider, useDrawers };
