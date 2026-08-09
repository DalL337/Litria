import { useCallback } from 'react';
import { Home, FileText } from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator
} from '@/components/ui/command';
import { getPieceDisplayName } from '../utils/pieceDisplay';

function getBasename(filename) {
  if (typeof filename !== 'string') return '';
  const normalized = filename.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export default function NodeSearchPanel({
  pieces,
  onNavigateToPiece,
  onNavigateHome,
  onClose
}) {
  const handleSelectPiece = useCallback((pieceId) => {
    const piece = pieces.find((p) => String(p.id) === pieceId);
    if (piece) {
      onNavigateToPiece(piece);
      onClose?.();
    }
  }, [pieces, onNavigateToPiece, onClose]);

  const handleSelectHome = useCallback(() => {
    onNavigateHome();
    onClose?.();
  }, [onNavigateHome, onClose]);

  return (
    <Command className="node-search-panel">
      <CommandInput placeholder="Search pieces..." />
      <CommandList>
        <CommandGroup>
          <CommandItem value="__home__" onSelect={handleSelectHome}>
            <Home className="node-search-home-icon" />
            <span>Home</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandEmpty>No pieces found.</CommandEmpty>
        <CommandGroup heading="Pieces">
          {pieces.map((piece) => {
            const displayName = getPieceDisplayName(piece);
            const basename = getBasename(piece.filename);
            const showFilename = displayName !== basename && basename;
            return (
              <CommandItem
                key={piece.id}
                value={String(piece.id)}
                keywords={[piece.label, piece.filename, basename].filter(Boolean)}
                onSelect={handleSelectPiece}
              >
                <FileText />
                <span>{displayName}</span>
                {showFilename && (
                  <span className="node-search-filename">({basename})</span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
