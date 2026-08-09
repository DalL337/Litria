export function getHeaderCommentForFilename(filename) {
  const safeName = typeof filename === 'string' ? filename.trim() : '';
  if (!safeName) return null;
  const ext = safeName.split('.').pop()?.toLowerCase();
  const lineComment = (prefix) => `${prefix} ${safeName}\n`;
  const blockComment = (open, close) => `${open} ${safeName} ${close}\n`;
  const jsonHeader = () => {
    const escaped = safeName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `{\n  "_cm_filename": "${escaped}"\n}\n`;
  };

  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'java':
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cs':
    case 'go':
    case 'rs':
      return lineComment('//');
    case 'py':
    case 'sh':
    case 'rb':
    case 'yml':
    case 'yaml':
    case 'toml':
      return lineComment('#');
    case 'css':
    case 'scss':
    case 'less':
      return blockComment('/*', '*/');
    case 'html':
    case 'htm':
    case 'md':
    case 'xml':
      return blockComment('<!--', '-->');
    case 'json':
      return jsonHeader();
    default:
      return lineComment('//');
  }
}
