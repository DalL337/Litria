import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

function CreatePieceModal({ isOpen, onCancel, onCreate, validateFilename }) {
  const [filename, setFilename] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const filenameRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    setFilename('');
    setLabel('');
    setError('');
    // Radix Dialog auto-focuses first focusable element,
    // but we want the filename input specifically.
    // Small delay lets the dialog portal mount first.
    requestAnimationFrame(() => {
      filenameRef.current?.focus();
    });
  }, [isOpen]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validateFilename(filename);
    if (validationError) {
      setError(validationError);
      return;
    }

    onCreate({
      filename: filename.trim(),
      label: label.trim()
    });
  };

  const handleOpenChange = (open) => {
    if (!open) {
      onCancel?.();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="create-piece-dialog"
        showCloseButton={false}
        aria-live="polite"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          filenameRef.current?.focus();
        }}
      >
        <form className="create-piece-form" onSubmit={handleSubmit}>
          <DialogTitle className="create-piece-modal-title">
            CREATE NEW PIECE
          </DialogTitle>
          {/* Screen-reader-only: satisfies Radix's aria-describedby contract
              (console warned "Missing Description" on every open). */}
          <DialogDescription className="sr-only">
            Creates a new file in the project and places its node on the canvas.
          </DialogDescription>

          <label className="create-piece-field" htmlFor="piece-filename">
            File Name
          </label>
          <input
            id="piece-filename"
            ref={filenameRef}
            className={`create-piece-input ${error ? 'is-invalid' : ''}`}
            type="text"
            value={filename}
            onChange={(event) => {
              setFilename(event.target.value);
              if (error) setError('');
            }}
            placeholder="e.g. main.js"
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'piece-filename-error' : undefined}
          />

          <label className="create-piece-field" htmlFor="piece-label">
            Label <span className="create-piece-optional">(Optional)</span>
          </label>
          <input
            id="piece-label"
            className="create-piece-input"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Startup Logic"
            autoComplete="off"
          />

          {error && (
            <div id="piece-filename-error" className="create-piece-error">
              {error}
            </div>
          )}

          <div className="create-piece-actions">
            <button className="create-piece-action" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="create-piece-action" type="submit">
              + Create
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default CreatePieceModal;
