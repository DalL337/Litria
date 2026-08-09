// useSelection.js
// Handles all selection logic: single select, multi-select, toggle, clear
// This is a "behavior" - pure logic, no visual rendering

import { useState, useCallback } from 'react';

function useSelection() {
  const [selectedIds, setSelectedIds] = useState([]);

  // Select a single item (replaces current selection)
  const select = useCallback((id) => {
    setSelectedIds([id]);
  }, []);

  // Add an item to current selection
  const add = useCallback((id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev : [...prev, id]
    );
  }, []);

  // Remove an item from selection
  const remove = useCallback((id) => {
    setSelectedIds(prev => prev.filter(selectedId => selectedId !== id));
  }, []);

  // Toggle an item (add if missing, remove if present)
  const toggle = useCallback((id) => {
    setSelectedIds(prev => 
      prev.includes(id) 
        ? prev.filter(selectedId => selectedId !== id)
        : [...prev, id]
    );
  }, []);

  // Clear all selections
  const clear = useCallback(() => {
    setSelectedIds([]);
  }, []);

  // Select multiple items at once (for lasso selection)
  const selectMultiple = useCallback((ids) => {
    setSelectedIds(ids);
  }, []);

  // Check if an item is selected
  const isSelected = useCallback((id) => {
    return selectedIds.includes(id);
  }, [selectedIds]);

  // Return everything the app might need
  return {
    selectedIds,      // The array of selected IDs
    select,           // Select single item
    add,              // Add to selection  
    remove,           // Remove from selection
    toggle,           // Toggle selection
    clear,            // Clear all
    selectMultiple,   // Select many at once
    isSelected,       // Check if selected
    hasSelection: selectedIds.length > 0,  // Quick boolean check
    count: selectedIds.length              // How many selected
  };
}

export default useSelection;