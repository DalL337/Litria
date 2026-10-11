import { useCallback } from 'react';

export function useScaffoldOperations({
  projectRootPath,
  fsManager,
  pillDomain,
  projectInstanceId
}) {
  const handleScaffoldDrop = useCallback(async (dropResult) => {
    if (!projectRootPath || !dropResult || !fsManager) return;
    const dragItem = dropResult.dragItem ?? dropResult.source;
    const dropTarget = dropResult.dropTarget ?? dropResult.target;
    if (!dragItem?.path || !dropTarget) return;

    const sourcePath = dragItem.path;
    const sourceName = sourcePath.split('/').pop();
    if (!sourceName) return;

    let destPath;
    if (dropTarget.position === 'inside') {
      const folder = dropTarget.path || '';
      destPath = folder ? `${folder}/${sourceName}` : sourceName;
    } else {
      const targetPath = dropTarget.path || '';
      const lastSlash = targetPath.lastIndexOf('/');
      const parentDir = lastSlash >= 0 ? targetPath.substring(0, lastSlash) : '';
      destPath = parentDir ? `${parentDir}/${sourceName}` : sourceName;
    }

    if (destPath === sourcePath) return;

    const isDir = dragItem.type === 'dir';
    if (isDir) {
      await fsManager.moveFolder(sourcePath, destPath);
    } else {
      await fsManager.moveFile(sourcePath, destPath);
    }
  }, [projectRootPath, fsManager]);

  const handleContextRename = useCallback(async (path, type, newName) => {
    if (!projectRootPath || !path || !fsManager) return;
    const lastSlash = path.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? path.substring(0, lastSlash) : '';
    const destPath = parentDir ? `${parentDir}/${newName}` : newName;

    if (destPath === path) return;

    const isDir = type === 'dir';
    if (isDir) {
      await fsManager.moveFolder(path, destPath);
    } else {
      await fsManager.moveFile(path, destPath);
    }
  }, [projectRootPath, fsManager]);

  const handleContextDelete = useCallback(async (path, type) => {
    if (!projectRootPath || !path || !fsManager) return;

    const isDir = type === 'dir';
    if (isDir) {
      await fsManager.deleteFolder(path);
    } else {
      await fsManager.deleteFile(path);
    }
  }, [projectRootPath, fsManager]);

  const handleContextNewFile = useCallback(async (parentPath, name) => {
    if (!projectRootPath || !fsManager) return;
    const filePath = parentPath ? `${parentPath}/${name}` : name;
    // createFile, never writeFile: "New file" must not replace a file that
    // already has the name. The drawer's own sibling check sees only the
    // visible tree, so `litria.toml`, OS-hidden files and anything created
    // since the last refresh used to be overwritten (W3a, 2026-10-11).
    // notify:false — a brand-new empty file has nothing for the syntax
    // domain yet; discovery registers it on the manager's scaffold refresh.
    const created = await fsManager.createFile(filePath, '', { notify: false });
    if (created?.success !== true) {
      pillDomain?.commands?.addPill({
        projectId: projectInstanceId,
        message: created?.code === 'fs.exists'
          ? `"${filePath}" already exists`
          : `Failed to create "${filePath}"`,
        severity: 'error'
      });
    }
  }, [projectRootPath, fsManager, pillDomain, projectInstanceId]);

  const handleContextNewFolder = useCallback(async (parentPath, name) => {
    if (!projectRootPath || !fsManager) return;
    const dirPath = parentPath ? `${parentPath}/${name}` : name;
    await fsManager.createDirectory(dirPath);
  }, [projectRootPath, fsManager]);

  return {
    handleScaffoldDrop,
    handleContextRename,
    handleContextDelete,
    handleContextNewFile,
    handleContextNewFolder
  };
}
