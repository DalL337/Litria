export function createSelectionDomain(selection) {
  return {
    commands: {
      select(id) {
        selection.select(id);
      },
      toggle(id) {
        selection.toggle(id);
      },
      clear() {
        selection.clear();
      },
      selectMultiple(ids) {
        selection.selectMultiple(ids);
      }
    },
    selectors: {
      getSelectedIds() {
        return selection.selectedIds;
      },
      getCount() {
        return selection.count;
      },
      hasSelection() {
        return selection.hasSelection;
      },
      isSelected(id) {
        return selection.isSelected(id);
      }
    }
  };
}

