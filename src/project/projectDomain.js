import {
  clearProjectStorageError,
  deleteProjectPath,
  getLastProjectStorageError,
  listProjectTree,
  moveProjectPath,
  openFileDialog,
  readProjectFile,
  writeProjectFile
} from './storage.js';

/**
 * projectDomain — thin wrapper around filesystem storage adapters.
 *
 * No manifest I/O: canvas state lives in the SQLite workspace database
 * (see `dbStorage.js`). This domain only exposes file-system read/write,
 * directory listing, and the last storage error for UI feedback.
 */
export function createProjectDomain({
  adapters = {}
} = {}) {
  const io = {
    readFile: adapters.readFile ?? readProjectFile,
    openFileDialog: adapters.openFileDialog ?? openFileDialog,
    writeFile: adapters.writeFile ?? writeProjectFile,
    movePath: adapters.movePath ?? moveProjectPath,
    deletePath: adapters.deletePath ?? deleteProjectPath,
    listTree: adapters.listTree ?? listProjectTree,
    getLastError: adapters.getLastError ?? getLastProjectStorageError,
    clearLastError: adapters.clearLastError ?? clearProjectStorageError
  };

  return {
    commands: {
      sync({ rootPath, fromRelative, toRelative }) {
        return io.movePath(rootPath, fromRelative, toRelative);
      },
      readFile(rootPath, relativePath) {
        return io.readFile(rootPath, relativePath);
      },
      openFileDialog() {
        return io.openFileDialog();
      },
      writeFile(rootPath, relativePath, contents) {
        return io.writeFile(rootPath, relativePath, contents);
      },
      movePath(rootPath, fromRelative, toRelative) {
        return io.movePath(rootPath, fromRelative, toRelative);
      },
      deletePath(rootPath, relativePath) {
        return io.deletePath(rootPath, relativePath);
      },
      listTree(rootPath) {
        return io.listTree(rootPath);
      },
      getLastStorageError() {
        return io.getLastError();
      },
      clearLastStorageError() {
        io.clearLastError();
      },
      // Legacy scaffold-plan applier is no longer wired (the new project
      // wizard uses `scaffold_project` directly). Retained as a no-op to
      // keep the call site in useProjectLaunch safe if a plan is ever passed.
      applyScaffold() {
        return Promise.resolve();
      }
    }
  };
}
