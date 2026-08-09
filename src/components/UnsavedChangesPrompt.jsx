import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

function UnsavedChangesPrompt({
  isOpen,
  title,
  message,
  onSave,
  onDiscard,
  onCancel
}) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => { if (!open) onCancel?.(); }}>
      <AlertDialogContent
        className="unsaved-prompt"
        onEscapeKeyDown={(e) => { e.preventDefault(); onCancel?.(); }}
      >
        <AlertDialogTitle className="unsaved-prompt-title">
          {title}
        </AlertDialogTitle>
        <AlertDialogDescription className="unsaved-prompt-message">
          {message}
        </AlertDialogDescription>
        <div className="unsaved-prompt-actions">
          <AlertDialogPrimitive.Cancel asChild>
            <button className="unsaved-prompt-button" type="button" onClick={onCancel}>
              Cancel
            </button>
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action asChild>
            <button className="unsaved-prompt-button" type="button" onClick={onDiscard}>
              Discard
            </button>
          </AlertDialogPrimitive.Action>
          <AlertDialogPrimitive.Action asChild>
            <button className="unsaved-prompt-button is-primary" type="button" onClick={onSave}>
              Save
            </button>
          </AlertDialogPrimitive.Action>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default UnsavedChangesPrompt;
