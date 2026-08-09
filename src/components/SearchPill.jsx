import { useCallback, useEffect } from 'react';
import { Search } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import NodeSearchPanel from './NodeSearchPanel';

export default function SearchPill({
  pieces,
  onNavigateToPiece,
  onNavigateHome,
  isOpen,
  setIsOpen
}) {
  const handleOpenChange = useCallback((open) => {
    setIsOpen(open);
  }, [setIsOpen]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, [setIsOpen]);

  // Sync: external open triggers (e.g. Ctrl+P) are handled via isOpen prop
  return (
    <div className="search-pill-container">
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button className="search-pill-trigger" type="button">
            <Search size={14} />
            <span>Search pieces...</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="search-pill-popover"
          side="bottom"
          align="center"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <NodeSearchPanel
            pieces={pieces}
            onNavigateToPiece={onNavigateToPiece}
            onNavigateHome={onNavigateHome}
            onClose={handleClose}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
